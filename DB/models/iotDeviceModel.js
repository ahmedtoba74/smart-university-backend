/**
 * ===================================================================================
 * @file      iotDeviceModel.js
 * @desc      Mongoose model for IoT ESP32 fingerprint devices.
 *            Tracks device role (central enrollment vs. room attendance), college
 *            binding, location binding, online/active state, firmware version, and
 *            heartbeat diagnostics. Used by triggerEnrollMode to resolve the correct
 *            enrollment station and by deviceHeartbeat to track device health (GAP-13).
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/models/iotDeviceModel
 */

import mongoose from "mongoose";

const iotDeviceSchema = new mongoose.Schema(
    {
        // ─── Device Identity ──────────────────────────────────────────────────────
        /**
         * deviceId — Human-readable unique device identifier (e.g., "FP-HALL-A-01").
         * Matches the ID configured in the ESP32 firmware and registered in Azure IoT Hub.
         * unique: true — one registry entry per physical device.
         */
        deviceId: {
            type: String,
            required: [true, "Device ID is required"],
            unique: true,
            trim: true,
            index: true,
        },
        /**
         * role — Defines the device's function in the system:
         * central: Used for student enrollment (fingerprint capture at admin station).
         * room:    Used for session attendance (fingerprint scan at classroom door).
         */
        role: {
            type: String,
            enum: ["central", "room"],
            required: [true, "Device role is required"],
        },

        // ─── Binding ──────────────────────────────────────────────────────────────
        /**
         * college_id — Scopes this device to a specific college.
         * triggerEnrollMode queries by { role: 'central', college_id, isActive: true }
         * to find the appropriate enrollment station when no deviceId is specified.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },
        /**
         * location_id — Room binding for role:'room' devices.
         * Null for central enrollment stations (not tied to a specific classroom).
         */
        location_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Location",
            default: null,
            index: true,
        },

        // ─── Firmware & Health ────────────────────────────────────────────────────
        firmwareVersion: {
            type: String,
            default: null,
        },
        lastHeartbeatAt: {
            type: Date,
            default: null,
        },
        lastSeenAt: {
            type: Date,
            default: null,
        },
        isOnline: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
        },

        // ─── Diagnostics (GAP-13 / heartbeat handler requirement) ─────────────────
        /**
         * diagnostics — Real-time hardware metrics sent by the device in heartbeat
         * telemetry. Used for monitoring and alerting on low-memory or poor WiFi
         * conditions that could cause template loading failures.
         */
        diagnostics: {
            freeHeap: { type: Number, default: null },  // Available heap memory in bytes
            wifiRSSI: { type: Number, default: null },  // WiFi signal strength in dBm
            uptime: { type: Number, default: null },    // Device uptime in seconds
        },
    },
    { timestamps: true },
);

const IoTDevice = mongoose.model("IoTDevice", iotDeviceSchema);
export default IoTDevice;
