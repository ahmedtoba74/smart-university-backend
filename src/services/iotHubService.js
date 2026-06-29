/**
 * ===================================================================================
 * @file      iotHubService.js
 * @desc      Azure IoT Hub service for ESP32 fingerprint device communication.
 *            Sends Direct Methods to devices: load templates, trigger enrollment mode,
 *            and clear device templates after a session ends.
 *            When IOT_MOCK_MODE=true or IOT_HUB_CONNECTION_STRING is absent, all
 *            methods return mock success stubs — full local testing without Azure.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/services/iotHubService
 */

import { createRequire } from 'module';
import { decryptFingerprintTemplate } from '../utils/cryptoUtils.js';
import crypto from 'crypto';

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
    templates.map((t) => {
        const decryptedBuffer = decryptFingerprintTemplate({
            ciphertext: t.templateData,
            iv: t.templateIv,
            authTag: t.templateAuthTag,
        });

        // 1) Verify Buffer Type
        console.log("Buffer.isBuffer:", Buffer.isBuffer(decryptedBuffer));
        console.log("Constructor:", decryptedBuffer.constructor.name);

        const sha256 = crypto.createHash('sha256').update(decryptedBuffer).digest('hex');
        const length = decryptedBuffer.length;
        const first64 = decryptedBuffer.subarray(0, 64).toString('hex');
        const middle64 = decryptedBuffer.subarray(352, 416).toString('hex');
        const last64 = decryptedBuffer.subarray(-64).toString('hex');
        const studentId = t.student_id;
        const encryptionVersion = t.encryptionVersion ?? 1;

        const ciphertextByteLen = Buffer.from(t.templateData, 'base64').length;
        const ivByteLen = Buffer.from(t.templateIv, 'hex').length;
        const authTagByteLen = Buffer.from(t.templateAuthTag, 'hex').length;

        const base64String = decryptedBuffer.toString('base64');
        const reconstructedBuffer = Buffer.from(base64String, 'base64');

        // PART 4 — After Decryption (Database Read)
        console.log(`\n============================================================`);
        console.log(`[DECRYPTED FROM DB]`);
        console.log(`Student ID:\n${studentId}`);
        console.log(`Template Length:\n${length}`);
        console.log(`Raw Buffer Length:\n${decryptedBuffer.length}`);
        console.log(`Base64 String Length:\n${base64String.length}`);
        console.log(`Decoded Buffer Length:\n${reconstructedBuffer.length}`);
        console.log(`SHA256:\n${sha256}`);
        console.log(`First 64 bytes:\n${first64}`);
        console.log(`Middle 64 bytes:\n${middle64}`);
        console.log(`Last 64 bytes:\n${last64}`);
        console.log(`Encryption Version:\n${encryptionVersion}`);
        console.log(`Ciphertext BYTE length:\n${ciphertextByteLen}`);
        console.log(`IV BYTE length:\n${ivByteLen}`);
        console.log(`AuthTag BYTE length:\n${authTagByteLen}`);
        console.log(`============================================================\n`);

        // PART 5 — Verify Base64 Round Trip
        const isIdentical = Buffer.compare(decryptedBuffer, reconstructedBuffer) === 0;

        console.log(`============================================================`);
        console.log(`[BASE64 ROUNDTRIP VERIFICATION (DB)]`);
        console.log(`BASE64 ROUNDTRIP IDENTICAL:\n${isIdentical}`);
        if (!isIdentical) {
            let mismatchIndex = -1;
            for (let i = 0; i < decryptedBuffer.length; i++) {
                if (decryptedBuffer[i] !== reconstructedBuffer[i]) {
                    mismatchIndex = i;
                    break;
                }
            }
            console.log(`First mismatch index:\n${mismatchIndex}`);
            console.log(`Original byte:\n${decryptedBuffer[mismatchIndex]}`);
            console.log(`Decoded byte:\n${reconstructedBuffer[mismatchIndex]}`);
        }
        console.log(`============================================================\n`);

        return base64String;
    });

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

        const payloadString = JSON.stringify(payload);
        const payloadSize = Buffer.byteLength(payloadString, 'utf8');

        // PART 6 — Before Direct Method
        console.log(`\n============================================================`);
        console.log(`[BEFORE DIRECT METHOD]`);
        console.log(`Payload size (bytes):\n${payloadSize}`);
        console.log(`JSON size:\n${payloadString.length}`);
        console.log(`Number of templates:\n${payload.templates.length}`);
        console.log(`TemplateBatchId:\n${payload.templateBatchId}`);
        console.log(`SessionId:\n${payload.sessionId}`);
        console.log(`============================================================\n`);

        console.log(`============================================================`);
        console.log(`[BEFORE DIRECT METHOD - TEMPLATES]`);
        payload.templates.forEach((tStr, idx) => {
            const templateBuffer = Buffer.from(tStr, 'base64');
            const sha256 = crypto.createHash('sha256').update(templateBuffer).digest('hex');
            const studentId = templates[idx]?.student_id || 'Unknown';
            const templateIndex = idx;
            
            // Middle 64 bytes
            const middle64 = templateBuffer.subarray(352, 416).toString('hex');
            const first32 = templateBuffer.subarray(0, 32).toString('hex');
            const last32 = templateBuffer.subarray(-32).toString('hex');

            // Verify Base64 Round Trip BEFORE sending Direct Method
            const reconstructed = Buffer.from(templateBuffer.toString('base64'), 'base64');
            const identical = Buffer.compare(templateBuffer, reconstructed) === 0;
            const roundtripSha = crypto.createHash('sha256').update(reconstructed).digest('hex');

            console.log(`Template Index: ${templateIndex}`);
            console.log(`Student ID: ${studentId}`);
            console.log(`Raw Buffer Length:\n${templateBuffer.length}`);
            console.log(`Base64 String Length:\n${tStr.length}`);
            console.log(`Decoded Buffer Length:\n${reconstructed.length}`);
            console.log(`Base64 STRING length (variable): ${tStr.length}`);
            console.log(`Decoded BYTE length (variable): ${templateBuffer.length}`);
            console.log(`SHA256: ${sha256}`);
            console.log(`First 32 bytes: ${first32}`);
            console.log(`Middle 64 bytes:\n${middle64}`);
            console.log(`Last 32 bytes: ${last32}`);
            console.log(`BASE64 ROUNDTRIP: ${identical}`);
            console.log(`ROUNDTRIP SHA256: ${roundtripSha}`);

            if (!identical) {
                let mismatchIndex = -1;
                for (let i = 0; i < templateBuffer.length; i++) {
                    if (templateBuffer[i] !== reconstructed[i]) {
                        mismatchIndex = i;
                        break;
                    }
                }
                console.log(`First mismatch index:\n${mismatchIndex}`);
                console.log(`Original byte:\n${templateBuffer[mismatchIndex]}`);
                console.log(`Reconstructed byte:\n${reconstructed[mismatchIndex]}`);
            }
            console.log(`--------------------------------------------------`);
        });
        console.log(`============================================================\n`);

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
