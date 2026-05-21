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

// ─── Mock Mode Guard ──────────────────────────────────────────────────────────
/**
 * Returns true when running without a real Azure IoT Hub connection.
 * Safe to call on every request — no side effects.
 * @returns {boolean}
 */
const isMockMode = () =>
    process.env.IOT_MOCK_MODE === 'true' ||
    !process.env.IOT_HUB_CONNECTION_STRING;

// ─── Azure IoT Hub Client (Lazy-loaded, CommonJS compat) ──────────────────────
/**
 * Lazily requires the 'azure-iothub' CommonJS package via createRequire.
 * This import is ONLY executed when isMockMode() returns false, which means
 * it never runs during local development, keeping startup fast and clean.
 * @returns {object} azure-iothub Client class
 */
let _iotHubClient = null;
let _iotHubClientReady = null;

/**
 * Lazily initializes and opens the Azure IoT Hub client.
 * Returns a Promise that resolves to the opened client instance.
 * The client is opened once and reused for all subsequent calls.
 * @returns {Promise<object>} Opened azure-iothub Client instance
 */
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
 * Invoke an Azure IoT Hub Direct Method on a target device.
 * @param {string} deviceId - Target device ID in IoT Hub
 * @param {string} methodName - Direct Method name (e.g., 'loadTemplates')
 * @param {object} payload - JSON payload for the method
 * @param {number} [connectTimeoutInSeconds=10]
 * @param {number} [responseTimeoutInSeconds=30]
 * @returns {Promise<{ success: boolean, result?: object, error?: string }>}
 */
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

// ─── Public Service Methods ───────────────────────────────────────────────────

/**
 * Push fingerprint templates to a room device before a session starts.
 * Decrypts each template from the database before sending to the ESP32.
 * Templates are sent as an ordered array; the device stores them at indices 0..N-1.
 * The device must echo sessionId, sessionNonce, and templateBatchId in all telemetry.
 *
 * @function pushTemplatesToDevice
 * @param {string} deviceId - Target room device ID
 * @param {Array<{ student_id: ObjectId, templateData: string, templateIv: string, templateAuthTag: string }>} templates
 *   Array of encrypted template documents (must have select('+templateData...') applied)
 * @param {{ sessionId: string, sessionNonce: string, templateBatchId: string }} sessionMeta
 * @returns {Promise<{ success: boolean, result?: object, error?: string, templatesLoaded?: number }>}
 */
export const pushTemplatesToDevice = async (deviceId, templates, sessionMeta) => {
    // R503 capacity guard — sensor supports max 200 templates (plan spec)
    if (templates.length > 200) {
        return {
            success: false,
            error: `Template count ${templates.length} exceeds R503 capacity limit of 200.`,
        };
    }

    if (isMockMode()) {
        console.log(
            `[IoT MOCK] pushTemplatesToDevice: device=${deviceId}, ` +
            `count=${templates.length}, session=${sessionMeta.sessionId}`,
        );
        return { success: true, templatesLoaded: templates.length };
    }

    try {
        // Decrypt templates inside this service boundary ONLY (D-13)
        // Raw template bytes must NEVER leave this function encrypted
        const decryptedTemplates = templates.map((t) => ({
            templateBuffer: decryptFingerprintTemplate({
                ciphertext: t.templateData,
                iv: t.templateIv,
                authTag: t.templateAuthTag,
            }).toString('base64'), // base64 for safe JSON transport to ESP32
        }));

        const payload = {
            sessionId: sessionMeta.sessionId.toString(),
            sessionNonce: sessionMeta.sessionNonce,
            templateBatchId: sessionMeta.templateBatchId,
            templates: decryptedTemplates,
        };

        const response = await invokeDirectMethod(
            deviceId,
            'loadTemplates',
            payload,
            10,
            60, // Template loading can take up to 60s for large batches
        );

        if (response.success) {
            return { success: true, templatesLoaded: templates.length, result: response.result };
        }
        return { success: false, error: response.error };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

/**
 * Trigger enrollment mode on a central fingerprint device.
 * The device will enter fingerprint capture mode and, upon successful capture,
 * POST to /attendance/fingerprints/register with the enrollmentNonce echoed back.
 *
 * @function triggerEnrollmentMode
 * @param {string} deviceId - Target central device ID
 * @param {{ studentId: string, enrolledBy: string, enrollmentNonce: string }} enrollmentMeta
 * @returns {Promise<{ success: boolean, result?: object, error?: string }>}
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
 * Clear all loaded fingerprint templates from a device after a session ends.
 * Called by endSession and expireDueSessions. Failure is best-effort — a failed
 * clear does NOT prevent session end or attendance recalculation.
 *
 * @function clearDeviceTemplates
 * @param {string} deviceId - Target device ID
 * @returns {Promise<{ success: boolean, result?: object, error?: string }>}
 */
export const clearDeviceTemplates = async (deviceId) => {
    if (isMockMode()) {
        console.log(`[IoT MOCK] clearDeviceTemplates: device=${deviceId}`);
        return { success: true };
    }

    try {
        const response = await invokeDirectMethod(
            deviceId,
            'clearTemplates',
            {},
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
