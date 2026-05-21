/**
 * ===================================================================================
 * @file      fingerprintEnrollmentRequestModel.js
 * @desc      Mongoose model for short-lived fingerprint enrollment requests.
 *            Created by POST /attendance/fingerprints/enroll-mode. The ESP32 device
 *            must echo the nonce in /fingerprints/register to bind the hardware event
 *            to the admin action that initiated it (GAP-12, D-14).
 * @module    DB/models/fingerprintEnrollmentRequestModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const fingerprintEnrollmentRequestSchema = new mongoose.Schema(
    {
        // ─── Request Participants ─────────────────────────────────────────────────
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
            index: true,
        },
        /**
         * requestedBy — The admin or doctor who triggered enrollment mode.
         * Set server-side from req.user._id in triggerEnrollMode.
         */
        requestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Requested by user ID is required"],
        },
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },
        /**
         * deviceId — The enrollment station (central R503 device) that will
         * physically capture the student's fingerprint.
         */
        deviceId: {
            type: String,
            required: [true, "Device ID is required"],
            index: true,
        },

        // ─── Nonce — Cryptographic Binding (GAP-12) ───────────────────────────────
        /**
         * nonce — nanoid(32) generated server-side in triggerEnrollMode.
         * Sent to the ESP32 via IoT Hub Direct Method. The device must echo it
         * in the /fingerprints/register payload. unique:true prevents nonce reuse.
         * registerFingerprint validates { student_id, nonce, deviceId, status: 'pending',
         * expiresAt: { $gt: new Date() } } before accepting any template.
         */
        nonce: {
            type: String,
            required: [true, "Enrollment nonce is required"],
            unique: true,
        },

        // ─── Lifecycle ────────────────────────────────────────────────────────────
        /**
         * status — Enrollment request state machine.
         * pending:   Created, waiting for device to complete enrollment.
         * completed: Device successfully sent /fingerprints/register.
         * expired:   expiresAt passed before completion (filtered by query, not TTL).
         * cancelled: Admin manually cancelled before completion.
         */
        status: {
            type: String,
            enum: ["pending", "completed", "expired", "cancelled"],
            default: "pending",
            index: true,
        },
        /**
         * expiresAt — Hard expiry for this enrollment request (2-minute TTL).
         * IMPORTANT: NO MongoDB TTL index ({ expireAfterSeconds: 0 }).
         * Physical deletion would destroy the expired/cancelled audit trail.
         * Filter expired requests with { expiresAt: { $gt: new Date() } }.
         * A cleanup job may mark stale pending requests as 'expired' without deleting.
         */
        expiresAt: {
            type: Date,
            required: [true, "Expiry time is required"],
            index: true,
        },
    },
    { timestamps: true },
);

const FingerprintEnrollmentRequest = mongoose.model(
    "FingerprintEnrollmentRequest",
    fingerprintEnrollmentRequestSchema,
);
export default FingerprintEnrollmentRequest;
