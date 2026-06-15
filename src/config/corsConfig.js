// src/config/corsConfig.js
// Shared CORS origin registry — single source of truth for both
// the Express HTTP server (app.js) and the Socket.io server (socketService.js).

export const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "smart-frontend-ege8cxbjbwfrhnah.austriaeast-01.azurewebsites.net",
    "http://smart-frontend-ege8cxbjbwfrhnah.austriaeast-01.azurewebsites.net",
    "https://smart-frontend-ege8cxbjbwfrhnah.austriaeast-01.azurewebsites.net",
];

// Inject production frontend URL at runtime if configured
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}
