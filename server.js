
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

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


// ================= TAWSILA PLACE SEARCH =================

// تخزين مؤقت لنتائج البحث لمدة 5 دقائق
const placeSearchCache = new Map();

app.get("/api/places/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();

        if (q.length < 2 || q.length > 80) {
            return res.json({
                success: true,
                places: []
            });
        }

        const cacheKey = q.toLowerCase();
        const cached = placeSearchCache.get(cacheKey);

        if (cached && cached.expiresAt > Date.now()) {
            return res.json({
                success: true,
                places: cached.places
            });
        }

        const params = new URLSearchParams({
            q: q + ", Ouargla, Algeria",
            lat: "31.95",
            lon: "5.32",
            zoom: "10",
            limit: "8",
            lang: "ar"
        });

        const response = await fetch(
            "https://photon.komoot.io/api/?" + params,
            {
                signal: AbortSignal.timeout(8000),
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error("Place search service unavailable");
        }

        const data = await response.json();

        const places = (data.features || [])
            .filter(feature => {
                const props = feature.properties || {};
                return props.countrycode === "DZ";
            })
            .map(feature => {
                const props = feature.properties || {};
                const coords = feature.geometry?.coordinates || [];

                return {
                    name: props.name || "",
                    city: props.city || props.county || "",
                    district: props.district || "",
                    street: props.street || "",
                    address: [
                        props.name,
                        props.street,
                        props.district,
                        props.city || props.county
                    ].filter(Boolean).join("، "),
                    lat: Number(coords[1]),
                    lng: Number(coords[0])
                };
            })
            .filter(place =>
                place.name &&
                Number.isFinite(place.lat) &&
                Number.isFinite(place.lng)
            );

        placeSearchCache.set(cacheKey, {
            places,
            expiresAt: Date.now() + 5 * 60 * 1000
        });

        // الحد من حجم التخزين المؤقت
        if (placeSearchCache.size > 200) {
            const firstKey = placeSearchCache.keys().next().value;
            placeSearchCache.delete(firstKey);
        }

        return res.json({
            success: true,
            places
        });

    } catch (error) {
        console.error("Place search error:", error.message);

        return res.status(503).json({
            success: false,
            message: "البحث عن الأماكن غير متاح حالياً",
            places: []
        });
    }
});

// ================= END TAWSILA PLACE SEARCH =================

// ================= PASSWORD SECURITY =================

const scryptAsync = require("util").promisify(crypto.scrypt);

async function hashPassword(password){

    const salt = crypto.randomBytes(16).toString("hex");

    const key = await scryptAsync(
        password,
        salt,
        64
    );

    return salt + ":" + key.toString("hex");
}


async function verifyPassword(password, storedHash){

    try{

        if(
            typeof password !== "string" ||
            typeof storedHash !== "string"
        ){
            return false;
        }

        const parts = storedHash.split(":");

        if(parts.length !== 2){
            return false;
        }

        const salt = parts[0];
        const storedKey = Buffer.from(parts[1], "hex");

        if(
            !/^[a-f0-9]{32}$/i.test(salt) ||
            storedKey.length !== 64
        ){
            return false;
        }

        const key = await scryptAsync(
            password,
            salt,
            64
        );

        return crypto.timingSafeEqual(
            key,
            storedKey
        );

    }catch(error){

        console.error("Password verification error:", error);

        return false;

    }

}

// ================= DRIVER SESSION SECURITY =================

function hashSessionToken(token){

    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

}


async function createDriverSession(driverId){

    // حذف الجلسات المنتهية
    await pool.query(
        "DELETE FROM driver_sessions WHERE expires_at <= NOW()"
    );

    // إنشاء رمز عشوائي قوي
    const token = crypto
        .randomBytes(32)
        .toString("hex");

    const tokenHash = hashSessionToken(token);

    // صلاحية الجلسة 30 يوماً
    const expiresAt = new Date(
        Date.now() + (30 * 24 * 60 * 60 * 1000)
    );

    await pool.query(
        `INSERT INTO driver_sessions
         (token_hash, driver_id, expires_at)
         VALUES ($1, $2, $3)`,
        [
            tokenHash,
            String(driverId),
            expiresAt
        ]
    );

    return {
        token,
        expiresAt
    };

}


 // ================= VERIFY DRIVER SESSION =================

async function getDriverFromSession(token){

    if(
        typeof token !== "string" ||
        !/^[a-f0-9]{64}$/i.test(token)
    ){
        return null;
    }

    const tokenHash = hashSessionToken(token);

    const result = await pool.query(
        `SELECT drivers.*
         FROM driver_sessions
         INNER JOIN drivers
         ON drivers.id = driver_sessions.driver_id
         WHERE driver_sessions.token_hash = $1
         AND driver_sessions.expires_at > NOW()`,
        [tokenHash]
    );

    if(!result.rowCount){
        return null;
    }

    return formatDriver(result.rows[0]);

}

// ================= END VERIFY DRIVER SESSION =================


// ================= END DRIVER SESSION SECURITY =================


// ================= END PASSWORD SECURITY =================


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

    
    // بيانات الاشتراك الشهري للسائقين
    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active'
    `);

    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ
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

        // إضافة كلمة المرور دون المساس بالحسابات القديمة
    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS password_hash TEXT
    `);

    
    // مواقع السائقين على الخريطة
    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION
    `);

    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION
    `);

    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS rides_status_idx
        ON rides(status)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS rides_driver_id_idx
        ON rides(driver_id)
    `);

    
    // جلسات دخول السائقين
    await pool.query(`
        CREATE TABLE IF NOT EXISTS driver_sessions (
            token_hash TEXT PRIMARY KEY,
            driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS driver_sessions_driver_id_idx
        ON driver_sessions(driver_id)
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
        createdAt: row.created_at,

        subscriptionStatus: row.subscription_status,
        subscriptionStartedAt: row.subscription_started_at,
        subscriptionExpiresAt: row.subscription_expires_at
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

        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول كسائق",
                rides: []
            });
        }

        const token = authHeader.slice(7);

        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة",
                rides: []
            });
        }

        const driverId = String(driver.id);

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

        return res.json({
            success: true,
            rides: result.rows.map(formatRide)
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END GET RIDES =================

// ================= DRIVER COMPLETED RIDES =================

app.get("/api/driver/completed-rides", async (req, res) => {
    try {
        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول كسائق",
                rides: []
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة",
                rides: []
            });
        }

        const result = await pool.query(
            `SELECT *
             FROM rides
             WHERE driver_id = $1
               AND status = 'completed'
             ORDER BY created_at DESC
             LIMIT 100`,
            [String(driver.id)]
        );

        return res.json({
            success: true,
            rides: result.rows.map(formatRide)
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END DRIVER COMPLETED RIDES =================

 // ================= REGISTER DRIVER =================

app.post("/api/driver", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();
        const password = req.body.password;
        const car = String(req.body.car || "").trim();
        const plate = String(req.body.plate || "").trim();

        if (!name || !phone || !car || !plate) {
            return res.status(400).json({
                success: false,
                message: "أكمل معلومات السائق"
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 8 ||
            password.length > 128
        ) {
            return res.status(400).json({
                success: false,
                message: "كلمة المرور يجب أن تكون بين 8 و128 حرفاً"
            });
        }

        const existing = await pool.query(
            "SELECT id FROM drivers WHERE phone = $1",
            [phone]
        );

        if (existing.rowCount) {
            return res.status(409).json({
                success: false,
                message: "رقم الهاتف مسجل من قبل. يرجى تسجيل الدخول أو تفعيل الحساب القديم."
            });
        }

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            
`INSERT INTO drivers
 (id, name, phone, car, plate, password_hash, subscription_status)
 VALUES ($1,$2,$3,$4,$5,$6,$7)
 RETURNING *`,

            [
                Date.now(),
                name,
                phone,
                car,
                plate,
                passwordHash,
                "pending"
            ]
        );

        const session = await createDriverSession(result.rows[0].id);

return res.json({
    success:true,
    driver:formatDriver(result.rows[0]),
    token:session.token,
    expiresAt:session.expiresAt
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


 // ================= DRIVER LOGIN =================

app.post("/api/driver/login", async (req, res) => {

    try{

        const phone = String(req.body.phone || "").trim();
        const password = req.body.password;

        if(
            !phone ||
            typeof password !== "string" ||
            password.length < 1 ||
            password.length > 128
        ){

            return res.status(400).json({
                success: false,
                message: "أدخل رقم الهاتف وكلمة المرور"
            });

        }

        const result = await pool.query(
            `SELECT *
             FROM drivers
             WHERE phone = $1`,
            [phone]
        );

        if(!result.rowCount){

            return res.status(401).json({
                success: false,
                message: "رقم الهاتف أو كلمة المرور غير صحيحة"
            });

        }

        const driverRow = result.rows[0];

        // الحسابات القديمة تحتاج تفعيل كلمة المرور
        if(!driverRow.password_hash){

            return res.status(403).json({
                success: false,
                message: "حسابك قديم ويحتاج تفعيل كلمة المرور من الإدارة"
            });

        }

        const passwordValid = await verifyPassword(
            password,
            driverRow.password_hash
        );

        if(!passwordValid){

            return res.status(401).json({
                success: false,
                message: "رقم الهاتف أو كلمة المرور غير صحيحة"
            });

        }

        const session = await createDriverSession(
            driverRow.id
        );

        return res.json({
            success: true,
            driver: formatDriver(driverRow),
            token: session.token,
            expiresAt: session.expiresAt
        });

    }catch(error){

        return sendError(res, error);

    }

});

// ================= END DRIVER LOGIN =================
// ================= DRIVER SESSION =================

app.get("/api/driver/me", async (req, res) => {
    try {
        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير موجودة"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "انتهت صلاحية الجلسة، يرجى تسجيل الدخول"
            });
        }

        return res.json({
            success: true,
            driver
        });

    } catch (error) {
        return sendError(res, error);
    }
});


// ================= END DRIVER SESSION =================
// ================= DRIVER LOGOUT =================

app.post("/api/driver/logout", async (req, res) => {

    try{

        const authHeader =
            req.get("authorization") || "";

        if(!authHeader.startsWith("Bearer ")){

            return res.status(401).json({
                success:false,
                message:"جلسة الدخول غير موجودة"
            });

        }

        const token = authHeader.slice(7);

        if(!/^[a-f0-9]{64}$/i.test(token)){

            return res.status(401).json({
                success:false,
                message:"رمز الجلسة غير صالح"
            });

        }

        const tokenHash = hashSessionToken(token);

        await pool.query("BEGIN");

try {

    await pool.query(
        `UPDATE drivers
         SET online = FALSE,
             latitude = NULL,
             longitude = NULL,
             location_updated_at = NULL
         WHERE id = (
             SELECT driver_id
             FROM driver_sessions
             WHERE token_hash = $1
         )`,
        [tokenHash]
    );

    await pool.query(
        `DELETE FROM driver_sessions
         WHERE token_hash = $1`,
        [tokenHash]
    );

    await pool.query("COMMIT");

} catch (error) {

    await pool.query("ROLLBACK");
    throw error;

}

        return res.json({
            success:true,
            message:"تم تسجيل الخروج بنجاح"
        });

    }catch(error){

        return sendError(res, error);

    }

});

// ================= END DRIVER LOGOUT =================
// ================= DRIVER STATUS =================

app.post("/api/driver/status", async (req, res) => {
    try {

        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول من جديد"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة"
            });
        }

        const { online } = req.body;

        if (typeof online !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "حالة السائق غير صحيحة"
            });
        }

        
        if (online === true) {
            const subscription = await pool.query(
                `SELECT subscription_status, subscription_expires_at
                 FROM drivers
                 WHERE id = $1`,
                [String(driver.id)]
            );

            const sub = subscription.rows[0];

                        if (
                !sub ||
                sub.subscription_status !== "active" ||
                (
                    sub.subscription_expires_at &&
                    new Date(sub.subscription_expires_at) <= new Date()
                )
            ) {
                return res.status(403).json({
                    success: false,
                    message: "اشتراكك غير مفعل أو انتهت صلاحيته. يرجى التواصل مع الإدارة."
                });
            }
        }

        
        const result = await pool.query(
    `UPDATE drivers
     SET online = $1,
         latitude = CASE WHEN $1 = FALSE THEN NULL ELSE latitude END,
         longitude = CASE WHEN $1 = FALSE THEN NULL ELSE longitude END,
         location_updated_at = CASE WHEN $1 = FALSE THEN NULL ELSE location_updated_at END
     WHERE id = $2
     RETURNING *`,
    [online, String(driver.id)]
);

        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود"
            });
        }

        return res.json({
            success: true,
            driver: formatDriver(result.rows[0])
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END DRIVER STATUS =================

// ================= DRIVER LOCATION UPDATE =================

app.post("/api/driver/location", async (req, res) => {
    try {

        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول من جديد"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة"
            });
        }

        const latitude = Number(req.body.latitude);
        const longitude = Number(req.body.longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return res.status(400).json({
                success: false,
                message: "إحداثيات الموقع غير صحيحة"
            });
        }

        const result = await pool.query(
            `UPDATE drivers
             SET latitude = $1,
                 longitude = $2,
                 location_updated_at = NOW()
             WHERE id = $3
               AND online = TRUE
             RETURNING id`,
            [latitude, longitude, String(driver.id)]
        );

        if (!result.rowCount) {
            return res.status(403).json({
                success: false,
                message: "يجب تفعيل حالة الاتصال أولاً"
            });
        }

        return res.json({
            success: true,
            message: "تم تحديث الموقع"
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END DRIVER LOCATION UPDATE =================

// ================= NEARBY DRIVERS =================


app.get("/api/drivers/nearby", async (req, res) => {
    try {

        const latitude = Number(req.query.latitude);
        const longitude = Number(req.query.longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return res.status(400).json({
                success: false,
                message: "موقع الزبون غير صحيح"
            });
        }

        const result = await pool.query(`
            SELECT
                latitude,
                longitude
            FROM drivers
            WHERE online = TRUE
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND latitude BETWEEN -90 AND 90
              AND longitude BETWEEN -180 AND 180
              AND location_updated_at >= NOW() - INTERVAL '60 seconds'
              AND (
                  6371 * ACOS(
                      LEAST(1, GREATEST(-1,
                          COS(RADIANS($1))
                          * COS(RADIANS(latitude))
                          * COS(RADIANS(longitude) - RADIANS($2))
                          + SIN(RADIANS($1))
                          * SIN(RADIANS(latitude))
                      ))
                  )
              ) <= 15
        `, [latitude, longitude]);

        return res.json({
            success: true,
            drivers: result.rows.map(row => ({
                latitude: Number(row.latitude),
                longitude: Number(row.longitude)
            }))
        });

    } catch (error) {
        return sendError(res, error);
    }
});


// ================= END NEARBY DRIVERS =================

// ================= ACCEPT RIDE =================

app.post("/api/rides/:id/accept", async (req, res) => {
    try {

        const rideId = req.params.id;

        if (!validId(rideId)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة غير صحيح"
            });
        }

        // التحقق من جلسة السائق
        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول من جديد"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة"
            });
        }

        const driverId = String(driver.id);

        const driverResult = await pool.query(
            `SELECT id, online, subscription_status, subscription_expires_at
 FROM drivers WHERE id = $1`,
            [driverId]
        );

        if (!driverResult.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود"
            });
        }

        const subscription = driverResult.rows[0];

                if (
            subscription.subscription_status !== "active" ||
            (
                subscription.subscription_expires_at &&
                new Date(subscription.subscription_expires_at) <= new Date()
            )
        ) {
            return res.status(403).json({
                success: false,
                message: "اشتراكك غير مفعل أو انتهت صلاحيته. يرجى التواصل مع الإدارة."
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

        return res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END ACCEPT RIDE =================

// ================= START RIDE =================

app.post("/api/rides/:id/start", async (req, res) => {
    try {

        const rideId = req.params.id;

        if (!validId(rideId)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة غير صحيح"
            });
        }

        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول من جديد"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة"
            });
        }

        const driverId = String(driver.id);

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

        return res.json({
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

        if (!validId(rideId)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة غير صحيح"
            });
        }

        const authHeader = req.get("authorization") || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "يرجى تسجيل الدخول من جديد"
            });
        }

        const token = authHeader.slice(7);
        const driver = await getDriverFromSession(token);

        if (!driver) {
            return res.status(401).json({
                success: false,
                message: "جلسة الدخول غير صالحة"
            });
        }

        const driverId = String(driver.id);

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

        return res.json({
            success: true,
            ride: formatRide(result.rows[0])
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END COMPLETE RIDE =================

// ================= PUBLIC RIDE STATUS =================

// حالة الرحلة وموقع السائق المرتبط بها فقط
app.get("/api/rides/:id", async (req, res) => {
    try {

        if (!validId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: "رقم الرحلة غير صحيح"
            });
        }

        const result = await pool.query(
            `SELECT
                r.id,
                r.status,
                d.latitude,
                d.longitude,
                d.location_updated_at
             FROM rides r
             LEFT JOIN drivers d
                ON d.id = r.driver_id
             WHERE r.id = $1`,
            [req.params.id]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "الرحلة غير موجودة"
            });
        }

        const ride = result.rows[0];

        let driverLocation = null;

        // نعرض الموقع فقط أثناء توجه السائق للزبون
        // أو أثناء تنفيذ الرحلة
        if (
            ["accepted", "started"].includes(ride.status) &&
            ride.latitude !== null &&
            ride.longitude !== null &&
            ride.location_updated_at &&
            Date.now() - new Date(ride.location_updated_at).getTime() <= 60000
        ) {

            driverLocation = {
                latitude: Number(ride.latitude),
                longitude: Number(ride.longitude),
                updatedAt: ride.location_updated_at
            };

        }

        return res.json({
            success: true,
            ride: {
                id: Number(ride.id),
                status: ride.status,
                driverLocation
            }
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END PUBLIC RIDE STATUS =================

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


// ================= ADMIN DRIVER SUBSCRIPTION =================

app.post("/api/admin/drivers/:id/subscription", async (req, res) => {
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

        const driverId = req.params.id;
        const action = req.body.action;

        if (!validId(driverId)) {
            return res.status(400).json({
                success: false,
                message: "رقم السائق غير صحيح"
            });
        }

        if (!["activate", "renew"].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "عملية الاشتراك غير صحيحة"
            });
        }

        const result = await pool.query(
            `UPDATE drivers
             SET
                subscription_status = 'active',
                subscription_started_at =
                    CASE
                        WHEN subscription_started_at IS NULL
                        THEN NOW()
                        ELSE subscription_started_at
                    END,
                subscription_expires_at =
                    CASE
                        WHEN subscription_expires_at > NOW()
                        THEN subscription_expires_at + INTERVAL '1 month'
                        ELSE NOW() + INTERVAL '1 month'
                    END
             WHERE id = $1
             RETURNING *`,
            [driverId]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "السائق غير موجود"
            });
        }

        return res.json({
            success: true,
            message: action === "activate"
                ? "تم تفعيل اشتراك السائق بنجاح"
                : "تم تجديد اشتراك السائق بنجاح",
            driver: formatDriver(result.rows[0])
        });

    } catch (error) {
        return sendError(res, error);
    }
});

// ================= END ADMIN DRIVER SUBSCRIPTION =================


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
