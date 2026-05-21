/**
 * ===================================================================================
 * @file      attendanceSessionModel.js
 * @desc      Mongoose model for a single attendance session tied to a course offering.
 *            Manages the full lifecycle: active → expired | ended. Supports fingerprint
 *            device template mapping, QR fallback tokens, and hall-switch audit trail.
 * @module    DB/models/attendanceSessionModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const attendanceSessionSchema = new mongoose.Schema(
    {
        // ─── Core References ──────────────────────────────────────────────────────
        courseOffering_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },
        location_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Location",
            required: [true, "Location ID is required"],
            index: true,
        },
        initiatedBy_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Initiator is required"],
        },
        /**
         * college_id — Tenant isolation field (same pattern as all Phase 3/4 models).
         * Pulled from offering.college_id at session creation, not from req.scopeFilter,
         * to ensure verified ownership rather than relying solely on request context.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        // ─── Timing ───────────────────────────────────────────────────────────────
        startTime: {
            type: Date,
            default: Date.now,
        },
        /**
         * expiresAt — Plain index only. The legacy TTL index (expireAfterSeconds: 0)
         * has been removed (CRIT-4 / GAP-1). Auto-deletion of sessions would silently
         * shrink totalSessions counts and inflate all attendance percentages.
         * Sessions are permanent historical records — ended explicitly via endSession
         * or the expireDueSessions cleanup job; never auto-deleted by MongoDB.
         */
        expiresAt: {
            type: Date,
            required: [true, "Expiration time is required"],
            index: true,
        },

        // ─── Session Lifecycle (GAP-14) ───────────────────────────────────────────
        /**
         * status — Explicit state machine: active → expired (time-based) | ended (manual).
         * Used by queries to filter sessions without relying solely on expiresAt comparison.
         */
        status: {
            type: String,
            enum: ["active", "expired", "ended"],
            default: "active",
            index: true,
        },
        endedAt: {
            type: Date,
            default: null,
        },
        endedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        endReason: {
            type: String,
            default: null,
        },

        // ─── Fingerprint Device Tracking (GAP-1) ─────────────────────────────────
        /**
         * deviceId — IoT fingerprint device ID bound to this session.
         * Null when running in QR-only fallback mode.
         */
        deviceId: {
            type: String,
            default: null,
        },
        /**
         * templateLoadStatus — Tracks the state of template loading on the ESP32.
         * Transitions: pending → loading → loaded | failed | qr_fallback.
         */
        templateLoadStatus: {
            type: String,
            enum: ["pending", "loading", "loaded", "failed", "qr_fallback"],
            default: "pending",
        },
        templatesLoadedCount: {
            type: Number,
            default: 0,
        },

        // ─── Offline Replay Safety (GAP-8) ───────────────────────────────────────
        /**
         * sessionNonce — Cryptographically unique per-session nonce sent to the ESP32
         * along with templates. The device must echo it in all telemetry so that
         * cached offline scans cannot be resolved against the wrong session.
         */
        sessionNonce: {
            type: String,
            required: [true, "Session nonce is required"],
            index: true,
        },
        /**
         * templateBatchId — Unique ID for the specific batch of templates loaded.
         * Changes on every template reload (e.g. after hall switch). Combined with
         * sessionNonce to form a cryptographic session identity for offline sync.
         */
        templateBatchId: {
            type: String,
            required: [true, "Template batch ID is required"],
            index: true,
        },

        // ─── Template Mapping (D-2) ───────────────────────────────────────────────
        /**
         * templateMapping — Maps R503 local template index → student ObjectId.
         * Backend pushes templates as an ordered array; localId corresponds to
         * the array index (0,1,2,...). When the device reports localId=3, the
         * backend resolves it to the matching student via this array.
         */
        templateMapping: [
            {
                localId: { type: Number },
                student_id: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
            },
        ],

        // ─── QR Fallback (D-3) ───────────────────────────────────────────────────
        /**
         * qrFallbackEnabled — Doctor manually enables QR fallback when fingerprint
         * device is offline or unavailable.
         */
        qrFallbackEnabled: {
            type: Boolean,
            default: false,
        },
        /**
         * qrFallbackToken — Short-lived random token (nanoid 32). Rotates every
         * QR_TOKEN_TTL_SECONDS to prevent attendance via screenshot.
         */
        qrFallbackToken: {
            type: String,
            default: null,
        },
        /**
         * qrTokenExpiresAt — Expiry for the current QR token.
         * After expiry + QR_TOKEN_GRACE_SECONDS, the token is invalid.
         */
        qrTokenExpiresAt: {
            type: Date,
            default: null,
        },
        /**
         * previousQrFallbackToken — The immediately preceding token, kept for the
         * grace window (QR_TOKEN_GRACE_SECONDS) so students mid-scan are not rejected
         * when the token rotates.
         */
        previousQrFallbackToken: {
            type: String,
            default: null,
        },
        previousQrTokenExpiresAt: {
            type: Date,
            default: null,
        },

        // ─── Hall Switching Audit Trail (D-4) ─────────────────────────────────────
        /**
         * originalLocation_id — The location_id before a hall switch was performed.
         * Null if no hall switch occurred during this session.
         */
        originalLocation_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Location",
            default: null,
        },
        hallSwitchReason: {
            type: String,
            default: null,
        },
    },
    { timestamps: true },
);

// ─── Compound Indexes ─────────────────────────────────────────────────────────
// GAP-9: Duplicate session guard — check by location+college and by offering
attendanceSessionSchema.index({ location_id: 1, college_id: 1, expiresAt: 1 });
attendanceSessionSchema.index({ courseOffering_id: 1, expiresAt: 1 });
// GAP-8: Offline replay safety — resolve session by cryptographic identity
attendanceSessionSchema.index({ sessionNonce: 1, templateBatchId: 1 });
// Fast lookup for active sessions per offering (endSession, expireDueSessions)
attendanceSessionSchema.index({ courseOffering_id: 1, status: 1 });

const AttendanceSession = mongoose.model(
    "AttendanceSession",
    attendanceSessionSchema,
);
export default AttendanceSession;
