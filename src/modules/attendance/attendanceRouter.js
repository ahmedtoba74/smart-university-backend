/**
 * ===================================================================================
 * @file      attendanceRouter.js
 * @desc      Express router for the Phase 5 Fingerprint Attendance System.
 *            Two authentication categories:
 *              1. JWT routes (doctor/ta/student/collegeAdmin):
 *                 protect → enforcePasswordChange → restrictTo → attachCollegeScope → handler
 *              2. IoT device routes (ESP32 hardware):
 *                 authenticateDevice only — NO protect, NO enforcePasswordChange
 * @module    src/modules/attendance/attendanceRouter
 * @requires  express, authMiddleware, enforcePasswordChange, attendanceMiddleware,
 *            attendanceController
 * ===================================================================================
 */

import express from "express";
import {
    protect,
    restrictTo,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";
import { authenticateDevice } from "../../middlewares/attendanceMiddleware.js";
import {
    createSession,
    getSessions,
    endSession,
    enableQrFallback,
    refreshQrToken,
    fingerprintMark,
    qrMark,
    getSessionReport,
    getMyAttendance,
    overrideAttendance,
    manualMarkAttendance,
    triggerEnrollMode,
    registerFingerprint,
    listFingerprints,
    checkStudentFingerprint,
    deleteFingerprint,
    deviceHeartbeat,
} from "./attendanceController.js";

const router = express.Router();

// ===================================================================================
// SESSION MANAGEMENT (Doctor / TA / CollegeAdmin)
// ===================================================================================

/**
 * POST /attendance/sessions
 * Create an attendance session, resolve the scheduled hall, push fingerprint templates
 * to the room device, and return the session with optional QR fallback token.
 */
router.post(
    "/sessions",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    createSession,
);

/**
 * GET /attendance/sessions
 * List attendance sessions for a course offering (paginated, filterable).
 */
router.get(
    "/sessions",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    getSessions,
);

/**
 * PATCH /attendance/sessions/:id/end
 * Force-end an active session, clear device templates, and recalculate attendance.
 */
router.patch(
    "/sessions/:id/end",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    endSession,
);

/**
 * PATCH /attendance/sessions/:id/enable-qr
 * Enable QR fallback for a session (when fingerprint device is offline or unreachable).
 * Generates the initial QR token.
 */
router.patch(
    "/sessions/:id/enable-qr",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    enableQrFallback,
);

/**
 * GET /attendance/sessions/:id/qr-token
 * Refresh the rotating QR token (every QR_TOKEN_TTL_SECONDS seconds).
 * Old token kept as previousQrFallbackToken for QR_TOKEN_GRACE_SECONDS.
 */
router.get(
    "/sessions/:id/qr-token",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    refreshQrToken,
);

// ===================================================================================
// ATTENDANCE MARKING
// ===================================================================================

/**
 * POST /attendance/fingerprint-mark
 * IoT device reports a fingerprint match. Authenticated by x-device-secret header only.
 * Exempt from JWT auth, enforcePasswordChange, and rate limiting (CRIT-2).
 * NOTE: The route-level body size override is NOT needed here — fingerprint-mark
 * payloads contain only IDs and metadata (< 1KB), not the raw template data.
 */
router.post("/fingerprint-mark", authenticateDevice, fingerprintMark);

/**
 * POST /attendance/devices/heartbeat
 * ESP32 device sends a periodic health ping. Upserts IoTDevice record.
 * Authenticated by x-device-secret header only.
 */
router.post("/devices/heartbeat", authenticateDevice, deviceHeartbeat);

/**
 * POST /attendance/qr-mark
 * Student submits attendance via QR code scan. Requires active session with
 * qrFallbackEnabled=true and a valid (current or grace-window previous) QR token.
 */
router.post(
    "/qr-mark",
    protect,
    enforcePasswordChange,
    restrictTo("student"),
    attachCollegeScope,
    qrMark,
);

/**
 * GET /attendance/sessions/:sessionId/report
 * Retrieve a full attendance report for a session (present/absent breakdown).
 */
router.get(
    "/sessions/:sessionId/report",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    getSessionReport,
);

/**
 * GET /attendance/my
 * Student retrieves their own attendance history and summary for a course offering.
 * Requires courseOffering_id as a query parameter.
 */
router.get(
    "/my",
    protect,
    enforcePasswordChange,
    restrictTo("student"),
    attachCollegeScope,
    getMyAttendance,
);

/**
 * PATCH /attendance/records/:id
 * Doctor/TA manually overrides an attendance record (mark present/absent).
 * overrideBy is always set server-side from req.user._id — never from body.
 */
router.patch(
    "/records/:id",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    overrideAttendance,
);

/**
 * POST /attendance/sessions/:sessionId/manual-mark
 * Doctor/TA manually marks a student present in a session.
 * Creates an AttendanceRecord with source='manual_override'.
 */
router.post(
    "/sessions/:sessionId/manual-mark",
    protect,
    enforcePasswordChange,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    manualMarkAttendance,
);

// ===================================================================================
// FINGERPRINT ENROLLMENT
// ===================================================================================

/**
 * POST /attendance/fingerprints/enroll-mode
 * CollegeAdmin triggers enrollment mode on the central fingerprint device.
 * Creates a FingerprintEnrollmentRequest with a 2-minute nonce TTL.
 */
router.post(
    "/fingerprints/enroll-mode",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    triggerEnrollMode,
);

/**
 * POST /attendance/fingerprints/register
 * ESP32 device POSTs captured fingerprint template after enrollment.
 * Authenticated by x-device-secret header only. Validates nonce before saving.
 * Route-level body size override: fingerprint base64 (~1KB) is well under 10KB global
 * limit, so no express.json({ limit: '5mb' }) override is needed unless 413s appear.
 */
router.post("/fingerprints/register", authenticateDevice, registerFingerprint);

/**
 * GET /attendance/fingerprints
 * List all enrolled fingerprint templates for a college (metadata only — no biometric data).
 */
router.get(
    "/fingerprints",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    listFingerprints,
);

/**
 * GET /attendance/fingerprints/student/:studentId
 * Check whether a specific student has an enrolled fingerprint template.
 * Returns { enrolled: boolean, template: object|null } — never biometric data.
 */
router.get(
    "/fingerprints/student/:studentId",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    checkStudentFingerprint,
);

/**
 * DELETE /attendance/fingerprints/:id
 * Hard-delete a fingerprint template. No soft-delete — device-side templates are
 * session-scoped and cleared at session end, so no need to keep the DB record.
 */
router.delete(
    "/fingerprints/:id",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    deleteFingerprint,
);

export default router;
