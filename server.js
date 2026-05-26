import dotenv from "dotenv";
import http from "http";
import dbConnection from "./DB/dbConnection.js";
import app from "./app.js";
import { expireDueSessions } from "./src/utils/attendanceUtils.js";
import { initSocket } from "./src/services/socketService.js";

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception! Shutting down...");
    console.error(err.name, err.message);
    process.exit(1);
});

dotenv.config();

const port = process.env.PORT || 3000;

dbConnection();

const server = http.createServer(app);
initSocket(server);

server.listen(port, () => {
    console.log(`
      ################################################
      🛡️  Smart University Server Listening on Port: ${port} 🛡️
      ################################################
      
      🚀  Env:        ${process.env.NODE_ENV}
      📅  Date:       ${new Date().toISOString()}
      💾  Database:   Connected
      🔒  Security:   Enabled (Helmet, RateLimit, Sanitizer)
      🔌  WebSocket:  Enabled (Socket.io)
      
      ################################################
    `);
});

// Phase 5 — Session expiry cleanup: check every 5 minutes for sessions
// that have passed their expiresAt time and are still marked 'active'.
// expireDueSessions transitions them to 'expired', clears device templates
// (best-effort), and recalculates attendance for all enrolled students.
const sessionCleanupInterval = setInterval(() => {
    expireDueSessions().catch((err) =>
        console.error('[SessionCleanup] Error:', err.message),
    );
}, 5 * 60 * 1000);

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection! Shutting down...");
    console.error(err.name, err.message);
    server.close(() => {
        process.exit(1);
    });
});

process.on("SIGTERM", () => {
    console.log("👋 SIGTERM RECEIVED. Shutting down gracefully");
    clearInterval(sessionCleanupInterval);
    server.close(() => {
        console.log("💥 Process terminated!");
    });
});
