
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing!");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error("PostgreSQL pool error:", error.message);
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function sendError(res, error) {
    console.error(error);
    return res.status(500).json({
        success: false,
        message: "حدث خطأ في الخادم، حاول مرة أخرى"
    });
}

function validText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function validId(value) {
    return /^\d{1,16}$/.test(String(value || ""));
}

// ================= DATABASE SETUP =================

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
            id BIGINT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS drivers (
            id BIGINT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            car TEXT NOT NULL,
            plate TEXT NOT NULL,
            online BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS rides (
            id BIGINT PRIMARY KEY,
            customer_name TEXT NOT NULL,
            customer_phone TEXT NOT NULL,
            pickup TEXT NOT NULL,
            destination TEXT NOT NULL,
            price NUMERIC NOT NULL DEFAULT 0,
            distance NUMERIC NOT NULL DEFAULT 0,
            car_type TEXT,
            pickup_location JSONB,
            destination_coords JSONB,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'started', 'completed')),
            driver_id BIGINT REFERENCES drivers(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS rides_status_idx
        ON rides(status)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS rides_driver_id_idx
        ON rides(driver_id)
    `);

    console.log("PostgreSQL tables are ready.");
}

// ================= DATA FORMAT =================

function formatDriver(row) {
    return {
        id: Number(row.id),
        name: row.name,
        phone: row.phone,
        car: row.car,
        plate: row.plate,
        online: row.online,
        createdAt: row.created_at
    };
}

function formatRide(row) {
    return {
        id: Number(row.id),
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        pickup: row.pickup,
        destination: row.destination,
        price: Number(row.price),
        distance: Number(row.distance),
        carType: row.car_type,
        pickupLocation: row.pickup_location,
        destinationCoords: row.destination_coords,
        status: row.status,
        driverId: row.driver_id === null ? null : Number(row.driver_id),
        createdAt: row.created_at
    };
}

// ================= HOME =================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= CUSTOMER =================

app.post("/api/customer", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();

        if (!validText(name) || !validText(phone)) {
            return res.status(400).json({
                success: false,
                message: "أدخل الاسم ورقم الهاتف"
            });
        }

        const result = await pool.query(
            `INSERT INTO customers (id, name, phone)
             VALUES ($1, $2, $3)
             ON CONFLICT (phone)
             DO UPDATE SET name = EXCLUDED.name
             RETURNING *`,
            [Date.now(), name, phone]
        );

        const row = result.rows[0];

        res.json({
            success: true,
            customer: {
                id: Number(row.id),
                name: row.name,
                phone: row.phone,
                createdAt: row.created_at
            }
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= CREATE RIDE =================

app.post("/api/rides", async (req, res) => {
    try {
        const {
            customerName,
            customerPhone,
            pickup,
            destination,
            price,
            distance,
            carType,
            pickupLocation,
            destinationCoords
        } = req.body;

        if (
            !validText(customerName) ||
            !validText(customerPhone) ||
            !validText(pickup) ||
            !validText(destination)
        ) {
            return res.status(400).json({
                success: false,
                message: "أكمل جميع المعلومات"
            });
        }

        const numericPrice = Number(price);
        const numericDistance = Number(distance);

        if (
            !Number.isFinite(numericPrice) ||
            numericPrice < 0 ||
            !Number.isFinite(numericDistance) ||
            numericDistance < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "السعر أو المسافة غير صحيحين"
            });
        }

        const customerPhoneClean = String(customerPhone).trim();
        const customerNameClean = String(customerName).trim();

        await pool.query(
            `INSERT INTO customers (id, name, phone)
             VALUES ($1, $2, $3)
             ON CONFLICT (phone)
             DO UPDATE SET name = EXCLUDED.name`,
            [Date.now(), customerNameClean, customerPhoneClean]
        );

        const id = Date.now();

        const result = await pool.query(
            `INSERT INTO rides (
                id, customer_name, customer_phone,
                pickup, destination, price, distance,
                car_type, pickup_location, destination_coords
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [
                id,
                customerNameClean,
                customerPhoneClean,
                String(pickup).trim(),
                String(destination).trim(),
                numericPrice,
                numericDistance,
                carType === "comfort" ? "comfort" : "normal",
                pickupLocation || null,
                destinationCoords || null
            ]
        );

        res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= GET RIDES FOR DRIVER =================

app.get("/api/rides", async (req, res) => {
    try {
        const driverId = String(req.query.driverId || "");

        // لا نعرض الرحلات للعامة دون هوية سائق
        if (!validId(driverId)) {
            return res.json({
                success: true,
                rides: []
            });
        }

        const driverResult = await pool.query(
            "SELECT id FROM drivers WHERE id = $1",
            [driverId]
        );

        if (!driverResult.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود",
                rides: []
            });
        }

        const result = await pool.query(
            `SELECT * FROM rides
             WHERE status = 'pending'
                OR (
                    driver_id = $1
                    AND status IN ('accepted', 'started')
                )
             ORDER BY created_at DESC`,
            [driverId]
        );

        res.json({
            success: true,
            rides: result.rows.map(formatRide)
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= REGISTER DRIVER =================

app.post("/api/driver", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();
        const car = String(req.body.car || "").trim();
        const plate = String(req.body.plate || "").trim();

        if (!name || !phone || !car || !plate) {
            return res.status(400).json({
                success: false,
                message: "أكمل معلومات السائق"
            });
        }

        const existing = await pool.query(
            "SELECT id FROM drivers WHERE phone = $1",
            [phone]
        );

        if (existing.rowCount) {
            return res.status(409).json({
                success: false,
                message: "رقم الهاتف مسجل من قبل. تسجيل دخول السائق يحتاج إلى تفعيل."
            });
        }

        const result = await pool.query(
            `INSERT INTO drivers (id, name, phone, car, plate)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING *`,
            [Date.now(), name, phone, car, plate]
        );

        res.json({
            success: true,
            driver: formatDriver(result.rows[0])
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "رقم الهاتف مسجل من قبل"
            });
        }
        return sendError(res, error);
    }
});

// ================= DRIVER STATUS =================

app.post("/api/driver/status", async (req, res) => {
    try {
        const { driverId, online } = req.body;

        if (!validId(driverId) || typeof online !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "بيانات حالة السائق غير صحيحة"
            });
        }

        const result = await pool.query(
            `UPDATE drivers
             SET online = $1
             WHERE id = $2
             RETURNING *`,
            [online, String(driverId)]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود"
            });
        }

        res.json({
            success: true,
            driver: formatDriver(result.rows[0])
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= ACCEPT RIDE =================

app.post("/api/rides/:id/accept", async (req, res) => {
    try {
        const rideId = req.params.id;
        const driverId = String(req.body.driverId || "");

        if (!validId(rideId) || !validId(driverId)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة أو السائق غير صحيح"
            });
        }

        const driverResult = await pool.query(
            "SELECT id, online FROM drivers WHERE id = $1",
            [driverId]
        );

        if (!driverResult.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود"
            });
        }

        if (!driverResult.rows[0].online) {
            return res.status(403).json({
                success: false,
                message: "يجب أن تكون متصلاً لقبول الرحلات"
            });
        }

        // تحديث ذري: سائق واحد فقط يستطيع قبول الرحلة
        const result = await pool.query(
            `UPDATE rides
             SET status = 'accepted', driver_id = $1
             WHERE id = $2 AND status = 'pending'
             RETURNING *`,
            [driverId, rideId]
        );

        if (!result.rowCount) {
            return res.status(409).json({
                success: false,
                message: "هذه الرحلة تم قبولها مسبقاً أو لم تعد متاحة"
            });
        }

        res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= START RIDE =================

app.post("/api/rides/:id/start", async (req, res) => {
    try {
        const rideId = req.params.id;
        const driverId = String(req.body.driverId || "");

        if (!validId(rideId) || !validId(driverId)) {
            return res.status(400).json({
                success: false,
                message: "بيانات الرحلة غير صحيحة"
            });
        }

        const result = await pool.query(
            `UPDATE rides
             SET status = 'started'
             WHERE id = $1
               AND driver_id = $2
               AND status = 'accepted'
             RETURNING *`,
            [rideId, driverId]
        );

        if (!result.rowCount) {
            return res.status(409).json({
                success: false,
                message: "لا يمكن بدء الرحلة. تحقق من حالة الرحلة والسائق."
            });
        }

        res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= COMPLETE RIDE =================

app.post("/api/rides/:id/complete", async (req, res) => {
    try {
        const rideId = req.params.id;
        const driverId = String(req.body.driverId || "");

        if (!validId(rideId) || !validId(driverId)) {
            return res.status(400).json({
                success: false,
                message: "بيانات الرحلة غير صحيحة"
            });
        }

        const result = await pool.query(
            `UPDATE rides
             SET status = 'completed'
             WHERE id = $1
               AND driver_id = $2
               AND status = 'started'
             RETURNING *`,
            [rideId, driverId]
        );

        if (!result.rowCount) {
            return res.status(409).json({
                success: false,
                message: "لا يمكن إنهاء الرحلة. تحقق من حالتها."
            });
        }

        res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= PUBLIC RIDE STATUS =================

// الزبون يحتاج حالة الرحلة فقط، وليس بياناته الشخصية
app.get("/api/rides/:id", async (req, res) => {
    try {
        if (!validId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة غير صحيح"
            });
        }

        const result = await pool.query(
            "SELECT id, status FROM rides WHERE id = $1",
            [req.params.id]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "الرحلة غير موجودة"
            });
        }

        res.json({
            success: true,
            ride: {
                id: Number(result.rows[0].id),
                status: result.rows[0].status
            }
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= ADMIN LOGIN =================

app.post("/api/admin/login", (req, res) => {
    const adminKey = process.env.ADMIN_KEY;

    if (!adminKey) {
        return res.status(503).json({
            success: false,
            message: "إعداد دخول الإدارة غير مكتمل في الخادم"
        });
    }

    const suppliedKey = String(req.body.key || "");

    if (suppliedKey !== adminKey) {
        return res.status(401).json({
            success: false,
            message: "رمز الإدارة غير صحيح"
        });
    }

    res.json({ success: true });
});

// ================= ADMIN DATA =================

app.get("/api/admin", async (req, res) => {
    try {
        const adminKey = process.env.ADMIN_KEY;

        if (!adminKey) {
            return res.status(503).json({
                success: false,
                message: "إعداد دخول الإدارة غير مكتمل"
            });
        }

        if (req.get("x-admin-key") !== adminKey) {
            return res.status(401).json({
                success: false,
                message: "يجب تسجيل الدخول إلى الإدارة"
            });
        }

        const [
            customersCount,
            driversCount,
            ridesCount,
            pendingCount,
            completedCount,
            drivers,
            customers,
            rides
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM customers"),
            pool.query("SELECT COUNT(*) FROM drivers"),
            pool.query("SELECT COUNT(*) FROM rides"),
            pool.query("SELECT COUNT(*) FROM rides WHERE status = 'pending'"),
            pool.query("SELECT COUNT(*) FROM rides WHERE status = 'completed'"),
            pool.query("SELECT * FROM drivers ORDER BY created_at DESC"),
            pool.query("SELECT * FROM customers ORDER BY created_at DESC"),
            pool.query("SELECT * FROM rides ORDER BY created_at DESC")
        ]);

        res.json({
            success: true,
            statistics: {
                customers: Number(customersCount.rows[0].count),
                drivers: Number(driversCount.rows[0].count),
                rides: Number(ridesCount.rows[0].count),
                pending: Number(pendingCount.rows[0].count),
                completed: Number(completedCount.rows[0].count)
            },
            drivers: drivers.rows.map(formatDriver),
            customers: customers.rows.map(row => ({
                id: Number(row.id),
                name: row.name,
                phone: row.phone,
                createdAt: row.created_at
            })),
            rides: rides.rows.map(formatRide)
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// ================= START SERVER =================

async function startServer() {
    try {
        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`Tawsila running on port ${PORT}`);
            console.log("PostgreSQL connection successful!");
        });
    } catch (error) {
        console.error("Database initialization failed:", error);
        process.exit(1);
    }
}

startServer();
