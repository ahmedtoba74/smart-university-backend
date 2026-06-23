/**
 * ===================================================================================
 * @file      attendanceMiddleware.js
 * @desc      Middleware for authenticating IoT fingerprint devices via shared secret.
 *            Device routes use x-device-secret header instead of JWT Bearer tokens.
 *            Uses timing-safe comparison to prevent timing-based secret extraction.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/middlewares/attendanceMiddleware
 */

import crypto from 'crypto';
import AppError from '../utils/appError.js';

/**
 * Authenticate an IoT fingerprint device using the shared secret header.
 * Synchronous middleware — no database calls, no catchAsync wrapper needed.
 *
 * Compares the x-device-secret header against IOT_DEVICE_SECRET using
 * crypto.timingSafeEqual to prevent timing attacks. Length must match first —
 * timingSafeEqual throws if buffers have different lengths.
 *
 * Applied ONLY to device-facing routes:
 *   POST /attendance/fingerprint-mark
 *   POST /attendance/fingerprints/register
 *   POST /attendance/devices/heartbeat
 *
 * Never applied to JWT-authenticated routes (protect + enforcePasswordChange handle those).
 *
 * @middleware authenticateDevice
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const authenticateDevice = (req, res, next) => {
    const secret = req.headers['x-device-secret'];

    // Reject if header is missing or env secret is not configured
    if (!secret || !process.env.IOT_DEVICE_SECRET) {
        return next(new AppError('Unauthorized device.', 401));
    }

    const a = Buffer.from(secret);
    const b = Buffer.from(process.env.IOT_DEVICE_SECRET);

    // timingSafeEqual requires equal-length buffers.
    // Different lengths means definitely not equal — fail fast without leaking info.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return next(new AppError('Unauthorized device.', 401));
    }

    next();
};
