const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const DATABASE_FILE = path.join(__dirname, "database.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));


// ================= DATABASE =================

function readDatabase() {

    try {

        if (!fs.existsSync(DATABASE_FILE)) {

            const data = {
                drivers: [],
                customers: [],
                rides: []
            };

            fs.writeFileSync(
                DATABASE_FILE,
                JSON.stringify(data, null, 2)
            );

            return data;
        }

        return JSON.parse(
            fs.readFileSync(DATABASE_FILE, "utf8")
        );

    } catch (error) {

        console.error(error);

        return {
            drivers: [],
            customers: [],
            rides: []
        };
    }
}


function saveDatabase(database) {

    fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(database, null, 2)
    );

}


// ================= HOME =================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );

});


// ================= CUSTOMER =================

app.post("/api/customer", (req, res) => {

    const database = readDatabase();

    const {
        name,
        phone
    } = req.body;

    if (!name || !phone) {

        return res.status(400).json({
            success: false,
            message: "أدخل الاسم ورقم الهاتف"
        });

    }

    const customer = {

        id: Date.now(),

        name,

        phone,

        createdAt: new Date().toISOString()

    };

    database.customers.push(customer);

    saveDatabase(database);

    res.json({

        success: true,

        customer

    });

});


// ================= CREATE RIDE =================

app.post("/api/rides", (req, res) => {

    const database = readDatabase();

    const {
        customerName,
        customerPhone,
        pickup,
        destination,
        price
    } = req.body;

    if (
        !customerName ||
        !customerPhone ||
        !pickup ||
        !destination
    ) {

        return res.status(400).json({

            success: false,

            message: "أكمل جميع المعلومات"

        });

    }

    const ride = {

        id: Date.now(),

        customerName,

        customerPhone,

        pickup,

        destination,

        price: Number(price) || 0,

        status: "pending",

        driverId: null,

        createdAt: new Date().toISOString()

    };

    database.rides.push(ride);

    saveDatabase(database);

    res.json({

        success: true,

        ride

    });

});


// ================= GET RIDES =================

app.get("/api/rides", (req, res) => {

    const database = readDatabase();

    res.json({

        success: true,

        rides: database.rides

    });

});


// ================= DRIVER =================

app.post("/api/driver", (req, res) => {

    const database = readDatabase();

    const {
        name,
        phone,
        car,
        plate
    } = req.body;

    if (!name || !phone || !car || !plate) {

        return res.status(400).json({

            success: false,

            message: "أكمل معلومات السائق"

        });

    }

    const driver = {

        id: Date.now(),

        name,

        phone,

        car,

        plate,

        online: true,

        createdAt: new Date().toISOString()

    };

    database.drivers.push(driver);

    saveDatabase(database);

    res.json({

        success: true,

        driver

    });

});


// ================= DRIVER STATUS =================

app.post("/api/driver/status", (req, res) => {

    const database = readDatabase();

    const {
        driverId,
        online
    } = req.body;

    const driver = database.drivers.find(
        d => d.id == driverId
    );

    if (!driver) {

        return res.status(404).json({

            success: false,

            message: "السائق غير موجود"

        });

    }

    driver.online = Boolean(online);

    saveDatabase(database);

    res.json({

        success: true,

        driver

    });

});


// ================= ACCEPT RIDE =================

app.post("/api/rides/:id/accept", (req, res) => {

    const database = readDatabase();

    const ride = database.rides.find(
        r => r.id == Number(req.params.id)
    );

    const {
        driverId
    } = req.body;

    const driver = database.drivers.find(
        d => d.id == driverId
    );

    if (!ride) {

        return res.status(404).json({

            success: false,

            message: "الطلب غير موجود"

        });

    }

    if (!driver) {

        return res.status(404).json({

            success: false,

            message: "السائق غير موجود"

        });

    }

    ride.status = "accepted";

    ride.driverId = driver.id;

    saveDatabase(database);

    res.json({

        success: true,

        ride

    });

});


// ================= START RIDE =================

app.post("/api/rides/:id/start", (req, res) => {

    const database = readDatabase();

    const ride = database.rides.find(
        r => r.id == Number(req.params.id)
    );

    if (!ride) {

        return res.status(404).json({

            success: false,

            message: "الرحلة غير موجودة"

        });

    }

    ride.status = "started";

    saveDatabase(database);

    res.json({

        success: true,

        ride

    });

});


// ================= COMPLETE RIDE =================

app.post("/api/rides/:id/complete", (req, res) => {

    const database = readDatabase();

    const ride = database.rides.find(
        r => r.id == Number(req.params.id)
    );

    if (!ride) {

        return res.status(404).json({

            success: false,

            message: "الرحلة غير موجودة"

        });

    }

    ride.status = "completed";

    saveDatabase(database);

    res.json({

        success: true,

        ride

    });

});


// ================= ADMIN =================

app.get("/api/admin", (req, res) => {

    const database = readDatabase();

    res.json({

        success: true,

        statistics: {

            customers: database.customers.length,

            drivers: database.drivers.length,

            rides: database.rides.length,

            pending: database.rides.filter(
                r => r.status === "pending"
            ).length,

            completed: database.rides.filter(
                r => r.status === "completed"
            ).length

        },

        drivers: database.drivers,

        customers: database.customers,

        rides: database.rides

    });

});


// ================= START SERVER =================

app.listen(PORT, () => {

    console.log(
        `Yassir V1 running on port ${PORT}`
    );

});
