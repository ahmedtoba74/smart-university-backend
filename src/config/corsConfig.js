// src/config/corsConfig.js
// Shared CORS origin registry — single source of truth for both
// the Express HTTP server (app.js) and the Socket.io server (socketService.js).

export const allowedOrigins = [
    "http://9.235.150.51",
    "https://9.235.150.51",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:5173",
];

// Inject production frontend URL at runtime if configured
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}
