/**
 * ===================================================================================
 * @file      iotHubService.js
 * @desc      Azure IoT Hub service for ESP32 fingerprint device communication.
 *            Sends Direct Methods to devices: load templates, trigger enrollment mode,
 *            and clear device templates after a session ends.
 *            When IOT_MOCK_MODE=true or IOT_HUB_CONNECTION_STRING is absent, all
 *            methods return mock success stubs — full local testing without Azure.
 * @module    src/services/iotHubService
 * @requires  module (createRequire), cryptoUtils
 * ===================================================================================
 */

import { createRequire } from 'module';
import { decryptFingerprintTemplate } from '../utils/cryptoUtils.js';

const DEFAULT_TEMPLATES_PER_BATCH = 7;

/**
 * Max templates per loadTemplates Direct Method (ESP32 MQTT buffer ~8192 bytes).
 * @returns {number}
 */
const getTemplatesPerBatch = () => {
    const n = Number(process.env.IOT_TEMPLATES_PER_BATCH);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : DEFAULT_TEMPLATES_PER_BATCH;
};

// ─── Mock Mode Guard ──────────────────────────────────────────────────────────
const isMockMode = () =>
    process.env.IOT_MOCK_MODE === 'true' ||
    !process.env.IOT_HUB_CONNECTION_STRING;

let _iotHubClient = null;
let _iotHubClientReady = null;

const getIotHubClient = () => {
    if (_iotHubClientReady) return _iotHubClientReady;
    _iotHubClientReady = (async () => {
        const require = createRequire(import.meta.url);
        const { Client } = require('azure-iothub');
        _iotHubClient = Client.fromConnectionString(
            process.env.IOT_HUB_CONNECTION_STRING,
        );
        await _iotHubClient.open();
        return _iotHubClient;
    })();
    return _iotHubClientReady;
};

/**
 * Parse JSON payload from an IoT Hub Direct Method response.
 * @param {object} result - Raw result from invokeDeviceMethod
 * @returns {object}
 */
const parseDirectMethodPayload = (result) => {
    try {
        const raw = result?.result?.payload;
        if (raw == null) return {};
        if (typeof raw === 'string') return JSON.parse(raw);
        if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
        if (typeof raw === 'object') return raw;
        return {};
    } catch {
        return {};
    }
};

const invokeDirectMethod = async (
    deviceId,
    methodName,
    payload,
    connectTimeoutInSeconds = 10,
    responseTimeoutInSeconds = 30,
) => {
    const methodParams = {
        methodName,
        payload,
        connectTimeoutInSeconds,
        responseTimeoutInSeconds,
    };

    try {
        const client = await getIotHubClient();
        return new Promise((resolve) => {
            client.invokeDeviceMethod(deviceId, methodParams, (err, result) => {
                if (err) {
                    return resolve({ success: false, error: err.message });
                }
                return resolve({ success: true, result });
            });
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
};

/**
 * Decrypt DB templates to base64 strings (firmware contract: flat string array).
 * @param {Array} templates
 * @returns {string[]}
 */
const decryptTemplatesToBase64 = (templates) =>
    templates.map((t) =>
        decryptFingerprintTemplate({
            ciphertext: t.templateData,
            iv: t.templateIv,
            authTag: t.templateAuthTag,
        }).toString('base64'),
    );

/**
 * Push fingerprint templates to a room device before a session starts.
 * Firmware expects: { sessionId, sessionNonce, templateBatchId, templates: string[], count }.
 * ESP32 MQTT limit: ~7 templates per call; sessions with more enrolled fingerprints
 * must use QR fallback until firmware supports append/chunked loads.
 *
 * @param {string} deviceId
 * @param {Array} templates - Encrypted template documents (+templateData fields selected)
 * @param {{ sessionId: object, sessionNonce: string, templateBatchId: string }} sessionMeta
 * @returns {Promise<{ success: boolean, templatesLoaded?: number, totalRequested?: number, error?: string, result?: object }>}
 */
export const pushTemplatesToDevice = async (deviceId, templates, sessionMeta) => {
    const totalRequested = templates.length;

    if (totalRequested > 200) {
        return {
            success: false,
            error: `Template count ${totalRequested} exceeds R503 capacity limit of 200.`,
            templatesLoaded: 0,
            totalRequested,
        };
    }

    const batchSize = getTemplatesPerBatch();
    if (totalRequested > batchSize) {
        return {
            success: false,
            error:
                `${totalRequested} fingerprint templates exceed the device MQTT batch limit ` +
                `(${batchSize} per loadTemplates call). Use QR fallback or enroll fewer students ` +
                `with fingerprints for this session.`,
            templatesLoaded: 0,
            totalRequested,
        };
    }

    if (isMockMode()) {
        console.log(
            `[IoT MOCK] pushTemplatesToDevice: device=${deviceId}, ` +
                `count=${totalRequested}, session=${sessionMeta.sessionId}`,
        );
        return { success: true, templatesLoaded: totalRequested, totalRequested };
    }

    try {
        const templateStrings = decryptTemplatesToBase64(templates);

        const payload = {
            sessionId: sessionMeta.sessionId.toString(),
            sessionNonce: sessionMeta.sessionNonce,
            templateBatchId: sessionMeta.templateBatchId,
            templates: templateStrings,
            count: templateStrings.length,
        };

        const response = await invokeDirectMethod(
            deviceId,
            'loadTemplates',
            payload,
            10,
            60,
        );

        if (!response.success) {
            return {
                success: false,
                error: response.error,
                templatesLoaded: 0,
                totalRequested,
            };
        }

        const devicePayload = parseDirectMethodPayload(response);
        const loaded =
            typeof devicePayload.loaded === 'number'
                ? devicePayload.loaded
                : templateStrings.length;
        const deviceTotal =
            typeof devicePayload.total === 'number'
                ? devicePayload.total
                : templateStrings.length;

        const fullyLoaded = loaded >= totalRequested && loaded > 0;

        return {
            success: fullyLoaded,
            templatesLoaded: loaded,
            totalRequested,
            deviceReportedTotal: deviceTotal,
            error: fullyLoaded
                ? undefined
                : `Device loaded ${loaded}/${totalRequested} templates.`,
            result: response.result,
        };
    } catch (err) {
        return {
            success: false,
            error: err.message,
            templatesLoaded: 0,
            totalRequested,
        };
    }
};

/**
 * Trigger enrollment mode on a central fingerprint device.
 * Firmware ACKs immediately; template arrives via D2C telemetry with enrollmentNonce echoed.
 */
export const triggerEnrollmentMode = async (deviceId, enrollmentMeta) => {
    if (isMockMode()) {
        console.log(
            `[IoT MOCK] triggerEnrollmentMode: device=${deviceId}, ` +
                `student=${enrollmentMeta.studentId}, nonce=${enrollmentMeta.enrollmentNonce}`,
        );
        return { success: true };
    }

    try {
        const payload = {
            studentId: enrollmentMeta.studentId.toString(),
            enrolledBy: enrollmentMeta.enrolledBy.toString(),
            enrollmentNonce: enrollmentMeta.enrollmentNonce,
        };

        const response = await invokeDirectMethod(
            deviceId,
            'startEnrollment',
            payload,
            10,
            30,
        );

        return response.success
            ? { success: true, result: response.result }
            : { success: false, error: response.error };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

/**
 * Clear loaded templates on the room device. Firmware requires sessionId (ADD-3 guard).
 * @param {string} deviceId
 * @param {string|import('mongoose').Types.ObjectId} sessionId
 */
export const clearDeviceTemplates = async (deviceId, sessionId) => {
    if (isMockMode()) {
        console.log(
            `[IoT MOCK] clearDeviceTemplates: device=${deviceId}, session=${sessionId}`,
        );
        return { success: true };
    }

    if (!sessionId) {
        return {
            success: false,
            error: 'sessionId is required for clearTemplates (firmware authorization guard).',
        };
    }

    try {
        const payload = { sessionId: sessionId.toString() };

        const response = await invokeDirectMethod(
            deviceId,
            'clearTemplates',
            payload,
            10,
            15,
        );

        return response.success
            ? { success: true, result: response.result }
            : { success: false, error: response.error };
    } catch (err) {
        return { success: false, error: err.message };
    }
};
