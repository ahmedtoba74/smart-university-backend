import dotenv from "dotenv";
import mongoose from "mongoose";
import dbConnection from "../DB/dbConnection.js";
import Location from "../DB/models/locationModel.js";
import IoTDevice from "../DB/models/iotDeviceModel.js";

dotenv.config({ path: '../.env' });

const seed = async () => {
    // 1. Connect to Database
    await dbConnection();

    // ==========================================
    // UPDATE THESE OBJECTIDS WITH YOUR REAL ONES
    // ==========================================
    const COLLEGE_ID = "69b5d5f2658a2ccf3f89a51a";
    const HALL_A_LOCATION_ID = "69b6038a04e25a65dcda1e3c";

    // 2. Clear out existing devices to prevent key conflicts
    await IoTDevice.deleteMany({});
    console.log("🧹 Cleared existing IoT devices.");

    // 3. Bind the room location's readerId
    const locationUpdate = await Location.updateOne(
        { _id: HALL_A_LOCATION_ID },
        {
            $set: {
                readerId: "smart-university-esp2",
                status: "active",
                isArchived: false
            }
        }
    );
    console.log(`📍 Location updated. Matches found: ${locationUpdate.matchedCount}`);

    // 4. Seed the IoT devices registry
    await IoTDevice.insertMany([
        {
            deviceId: "smart-university-esp",
            role: "central",
            college_id: COLLEGE_ID,
            location_id: null,
            isActive: true,
            isOnline: false,
            firmwareVersion: "1.0.0",
            lastHeartbeatAt: null,
            diagnostics: { freeHeap: null, wifiRSSI: null, uptime: null }
        },
        {
            deviceId: "smart-university-esp2",
            role: "room",
            college_id: COLLEGE_ID,
            location_id: HALL_A_LOCATION_ID,
            isActive: true,
            isOnline: false,
            firmwareVersion: "1.0.0",
            lastHeartbeatAt: null,
            diagnostics: { freeHeap: null, wifiRSSI: null, uptime: null }
        }
    ]);
    console.log("🚀 IoT devices registered successfully.");

    // 5. Disconnect cleanly
    await mongoose.disconnect();
    console.log("🔌 Database disconnected.");
};

seed().catch((err) => {
    console.error("💥 Seeding error:", err);
    process.exit(1);
});
