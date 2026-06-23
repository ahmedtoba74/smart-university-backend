/**
 * ===================================================================================
 * @file      dbConnection.js
 * @desc      Database connection setup. Resolves the database URI and establishes connection via Mongoose. Handles dropping of legacy indexes.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Connection
 */

import mongoose from "mongoose";

/**
 * Connects to MongoDB database using the URI defined in environment variables.
 * Also performs startup checks and drops legacy indexes (e.g., AttendanceSession expiry).
 *
 * @async
 * @function dbConnection
 * @returns {Promise<typeof import("mongoose")>} Resolves to the mongoose instance on success.
 */
const dbConnection = async () => {
    const uri =
        process.env.MONGO_URI ||
        process.env.DB_CONNECTION?.replace(
            "<username>",
            process.env.DB_USERNAME || "",
        )?.replace("<db_password>", process.env.DB_PASSWORD || "");
    if (!uri) {
        console.log("Database Error: MONGO_URI or DB_CONNECTION is required");
        process.exit(1);
    }
    return await mongoose
        .connect(uri)
        .then(() => {
            const db = mongoose.connection.db;
            const dbName = db?.databaseName ?? "unknown";
            const host = mongoose.connection.host ?? "unknown";
            console.log(`Database Connected successfully`);
            console.log(`  → Database name: "${dbName}"`);
            console.log(`  → Host: ${host}`);

            // CRIT-4: Drop the legacy TTL index on AttendanceSession.expiresAt.
            // The old schema used { expireAfterSeconds: 0 }, which caused MongoDB to
            // auto-delete expired sessions. This silently shrinks totalSessions over
            // time and inflates all attendance percentages. Sessions must be permanent
            // historical records — they are ended explicitly, never auto-deleted.
            // Schema change alone is NOT enough; the index must be dropped in MongoDB.
            // .catch(() => {}) is intentional: safe to run on every startup;
            // silently no-ops after the first successful drop.
            mongoose.connection.db
                .collection("attendancesessions")
                .dropIndex("expiresAt_1")
                .catch(() => { });
        })
        .catch((err) => {
            console.log(`Database Error: ${err}`);
            process.exit(1);
        });
};

export default dbConnection;
