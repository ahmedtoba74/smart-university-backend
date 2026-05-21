/**
 * ===================================================================================
 * @file      attendanceRecordModel.js
 * @desc      Mongoose model for a single student attendance record within a session.
 *            Tracks the source of attendance (fingerprint, QR, manual override),
 *            device metadata, biometric confidence score, offline sync identifiers,
 *            and override audit trail.
 * @module    DB/models/attendanceRecordModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const attendanceRecordSchema = new mongoose.Schema(
    {
        // ─── Core References (existing — preserved) ───────────────────────────────
        session_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceSession",
            required: [true, "Session ID is required"],
            index: true,
        },
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
            index: true,
        },
        /**
         * timestamp — The canonical time this attendance record is considered to have
         * occurred. For fingerprint marks this is the device scanTime (within clock
         * skew limits); for QR/manual it is server receive time.
         * Used as the sort key in getMyAttendance (phase5_plan line 1513).
         */
        timestamp: {
            type: Date,
            default: Date.now,
        },

        // ─── Tenant Isolation (GAP-2) ─────────────────────────────────────────────
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },
        /**
         * courseOffering_id — Denormalized from the session for efficient per-offering
         * attendance aggregation without a $lookup on every recalculation query.
         * NOTE: In Enrollment the same reference is stored as `course_id` (MED-2).
         */
        courseOffering_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },

        // ─── Attendance Source (GAP-2) ────────────────────────────────────────────
        /**
         * source — How this attendance record was created.
         * fingerprint: ESP32 reported a match → /fingerprint-mark
         * qr:          Student scanned QR code → /qr-mark
         * manual_override: Doctor/TA manually marked → PATCH /records/:id
         */
        source: {
            type: String,
            enum: ["fingerprint", "qr", "manual_override"],
            required: [true, "Attendance source is required"],
            default: "fingerprint",
        },

        // ─── Device Metadata ──────────────────────────────────────────────────────
        /**
         * deviceId — The IoT fingerprint device that reported this scan.
         * Null for QR and manual_override records.
         */
        deviceId: {
            type: String,
            default: null,
        },
        /**
         * confidence — Fingerprint match confidence score (0–100) reported by
         * the R503 sensor. Null for QR and manual_override sources.
         * Records with confidence below FINGERPRINT_MIN_CONFIDENCE are rejected
         * before this record is created.
         */
        confidence: {
            type: Number,
            default: null,
        },

        // ─── Timestamp Tracking ───────────────────────────────────────────────────
        /**
         * scannedAt — The actual scan timestamp reported by the ESP32 device.
         * May differ from receivedAt for offline-cached scans (GAP-8).
         */
        scannedAt: {
            type: Date,
            default: null,
        },
        /**
         * receivedAt — When the backend received the fingerprint-mark request.
         * Always set server-side; used to distinguish online vs. offline-replayed scans.
         */
        receivedAt: {
            type: Date,
            default: Date.now,
        },

        // ─── Offline Replay Safety (GAP-8) ───────────────────────────────────────
        /**
         * sessionNonce / templateBatchId — Echoed from the ESP32 telemetry payload.
         * Used to verify that a cached offline scan belongs to the correct session
         * and template batch, preventing cross-session identity confusion.
         */
        sessionNonce: {
            type: String,
            default: null,
        },
        templateBatchId: {
            type: String,
            default: null,
        },

        // ─── Manual Override Audit Trail ──────────────────────────────────────────
        /**
         * overrideBy — The User._id of the doctor or TA who performed the override.
         * Always set server-side from req.user._id — never from the request body
         * (OVERRIDE_RECORD_ALLOWED whitelist contains only 'overrideReason').
         */
        overrideBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        overrideReason: {
            type: String,
            default: null,
        },
    },
    { timestamps: true },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
/**
 * BE-CRIT-2: Unique compound index — prevents duplicate attendance records for
 * the same student in the same session. The 11000 duplicate key error from this
 * index is the mechanism fingerprintMark and qrMark use to detect re-scans.
 * Do NOT remove or modify this index.
 */
attendanceRecordSchema.index({ session_id: 1, student_id: 1 }, { unique: true });

/**
 * Per-student per-offering index — used by recalculateAttendance() to count
 * attended sessions efficiently without a collection scan.
 */
attendanceRecordSchema.index({ student_id: 1, courseOffering_id: 1 });

const AttendanceRecord = mongoose.model(
    "AttendanceRecord",
    attendanceRecordSchema,
);
export default AttendanceRecord;
