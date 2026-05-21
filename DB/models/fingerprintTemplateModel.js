/**
 * ===================================================================================
 * @file      fingerprintTemplateModel.js
 * @desc      Mongoose model for encrypted biometric fingerprint templates.
 *            Stores AES-256-GCM encrypted R503 fingerprint template data per student.
 *            Templates are decrypted only inside iotHubService when pushed to devices.
 *            API responses NEVER expose raw template bytes (select: false on all crypto fields).
 * @module    DB/models/fingerprintTemplateModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const fingerprintTemplateSchema = new mongoose.Schema(
    {
        /**
         * student_id — One fingerprint template per student (unique: true).
         * Upserted on re-enrollment: updating template replaces the existing record.
         */
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
            unique: true,
            index: true,
        },

        // ─── Encrypted Biometric Payload (GAP-11, D-13) ───────────────────────────
        /**
         * templateData — AES-256-GCM encrypted fingerprint template, stored as
         * base64 string. Raw biometric bytes are NEVER stored unencrypted.
         * select: false — excluded from all queries unless explicitly requested with
         * .select('+templateData +templateIv +templateAuthTag').
         * Only iotHubService.pushTemplatesToDevice() ever requests these fields.
         */
        templateData: {
            type: String,
            required: [true, "Template data is required"],
            select: false,
        },
        /**
         * templateIv — AES-GCM initialization vector (12 bytes, stored as hex).
         * select: false — never returned in API responses.
         */
        templateIv: {
            type: String,
            required: [true, "Template IV is required"],
            select: false,
        },
        /**
         * templateAuthTag — AES-GCM authentication tag (16 bytes, stored as hex).
         * Verifies integrity and authenticity of the ciphertext on decryption.
         * select: false — never returned in API responses.
         */
        templateAuthTag: {
            type: String,
            required: [true, "Template auth tag is required"],
            select: false,
        },
        /**
         * encryptionVersion — Allows future key rotation or algorithm upgrades
         * without reprocessing all templates at once.
         */
        encryptionVersion: {
            type: Number,
            default: 1,
        },

        // ─── Template Quality & Enrollment Metadata ───────────────────────────────
        /**
         * quality — Fingerprint capture quality score (0–100) reported by the R503
         * sensor at enrollment time. Higher = more reliable match.
         */
        quality: {
            type: Number,
            min: 0,
            max: 100,
        },
        /**
         * enrolledViaDevice — The deviceId of the R503 device used during enrollment.
         * Required for audit: tracks which physical scanner captured this template.
         */
        enrolledViaDevice: {
            type: String,
            required: [true, "Enrollment device ID is required"],
        },
        /**
         * enrolledBy — The admin/doctor who triggered enrollment mode.
         * Set from req.user._id in triggerEnrollMode — never from device payload.
         */
        enrolledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },

        // ─── Tenant Isolation ─────────────────────────────────────────────────────
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        // ─── Enrollment State ─────────────────────────────────────────────────────
        /**
         * isActive — BE-MED-R1: Uses 'isActive' instead of the standard 'isArchived'.
         * Represents the device enrollment state (enrolled vs. deactivated) rather
         * than administrative archival. The standard applyIsArchivedGuard utility
         * and pre-find hooks must NOT be applied to this model.
         */
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true },
);

const FingerprintTemplate = mongoose.model(
    "FingerprintTemplate",
    fingerprintTemplateSchema,
);
export default FingerprintTemplate;
