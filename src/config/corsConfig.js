/**
 * ===================================================================================
 * @file      corsConfig.js
 * @desc      Shared CORS configuration registry.
 *            This acts as the single source of truth for both the Express HTTP server (app.js)
 *            and the Socket.io WebSocket server (socketService.js).
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Config/CORS
 */

/**
 * List of allowed origins for CORS.
 * @type {string[]}
 */
export const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "smart-frontend-ege8cxbjbwfrhnah.austriaeast-01.azurewebsites.net",
    "https://smart-frontend-ege8cxbjbwfrhnah.austriaeast-01.azurewebsites.net",
];

// Inject production frontend URL at runtime if configured
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

/**
 * Shared CORS origin handler for both the Express HTTP server (app.js)
 * and the Socket.io server (socketService.js).
 *
 * Behavior:
 * - No Origin header (server-to-server, curl, Postman) → always allowed.
 * - Any origin in non-production environments → allowed for local testing.
 * - Production: allowed origins pass, all others are warned and rejected.
 *   The warn (not throw) keeps the socket alive and avoids log spam from
 *   legitimate browser preflight retries, while still providing audit visibility
 *   into unauthorized probes.
 *
 * @param {string|undefined} origin - The origin header from the request.
 * @param {Function} cb - The callback function (callback(err, originAllowed)).
 * @returns {any} Call to callback function.
 */
export const corsOriginHandler = (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== "production") return cb(null, true);
    // Warn instead of silently dropping — gives security audit visibility
    // without crashing on unknown origins or polluting logs with full stack traces.
    console.warn(
        `[CORS] Blocked unauthorized origin: "${origin}" at ${new Date().toISOString()}`,
    );
    return cb(null, false);
};
