/**
 * ===================================================================================
 * @file      cryptoUtils.js
 * @desc      Cryptographic utilities for password hashing, encrypting templates, and signature verification.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/Crypto
 */

import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const ALGORITHM = process.env.ENCRYPTION_ALGORITHM || "aes-256-cbc";

const IV_LENGTH = parseInt(process.env.ENCRYPTION_IV_LENGTH, 10) || 16;

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
    throw new Error(
        "FATAL ERROR: ENCRYPTION_KEY must be exactly 32 characters long.",
    );
}
if (!process.env.HASH_SECRET) {
    throw new Error("FATAL ERROR: HASH_SECRET is missing from env variables.");
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const HASH_SECRET = process.env.HASH_SECRET;

/**
 * Encrypt a string using AES-256-CBC.
 * @function encrypt
 * @param {string} text - The text to encrypt.
 * @returns {string|null} The encrypted string in format "iv:content" or null if input is invalid.
 */
export const encrypt = (text) => {
    if (!text) return null;

    let iv = crypto.randomBytes(IV_LENGTH);

    let cipher = crypto.createCipheriv(
        ALGORITHM,
        Buffer.from(ENCRYPTION_KEY),
        iv,
    );

    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return iv.toString("hex") + ":" + encrypted.toString("hex");
};

/**
 * Decrypt a string using AES-256-CBC.
 * @function decrypt
 * @param {string} text - The encrypted string in format "iv:content".
 * @returns {string|null} The decrypted string or null if decryption fails.
 */
export const decrypt = (text) => {
    if (!text) return null;

    try {
        let textParts = text.split(":");
        let iv = Buffer.from(textParts.shift(), "hex");
        let encryptedText = Buffer.from(textParts.join(":"), "hex");

        let decipher = crypto.createDecipheriv(
            ALGORITHM,
            Buffer.from(ENCRYPTION_KEY),
            iv,
        );

        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    } catch (error) {
        console.error("Decryption Error:", error.message);
        return null;
    }
};

/**
 * Create a deterministic hash for searching purposes.
 * @function hashForSearch
 * @param {string} text - The text to hash.
 * @returns {string|null} The SHA-256 hash or null if input is invalid.
 */
export const hashForSearch = (text) => {
    if (!text) return null;

    return crypto
        .createHash("sha256")
        .update(text + HASH_SECRET)
        .digest("hex");
};

/**
 * Encrypt plaintext for temporary passwords in BulkImportLog using AES-256-GCM.
 * GCM provides both confidentiality and authentication (AEAD).
 * @function encryptBulkPassword
 * @param {string} plaintext - The plaintext password to encrypt
 * @param {string} secret - Encryption secret (should be 32 bytes hex or derived from env)
 * @returns {string|null} Ciphertext in format "iv:authTag:encryptedData" (all hex encoded) or null if encryption fails
 */
export const encryptBulkPassword = (plaintext, secret) => {
    if (!plaintext || !secret) return null;

    try {
        const algorithm = "aes-256-gcm";
        const iv = crypto.randomBytes(16);

        // Derive a proper 32-byte key from secret if needed
        let key;
        if (Buffer.byteLength(secret) === 32) {
            key = Buffer.from(secret);
        } else {
            key = crypto.createHash("sha256").update(secret).digest();
        }

        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(plaintext, "utf8", "hex");
        encrypted += cipher.final("hex");

        const authTag = cipher.getAuthTag();

        return (
            iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted
        );
    } catch (error) {
        console.error("Encryption error:", error.message);
        return null;
    }
};

/**
 * Decrypt ciphertext from BulkImportLog using AES-256-GCM.
 * @function decryptBulkPassword
 * @param {string} ciphertext - Ciphertext in format "iv:authTag:encryptedData"
 * @param {string} secret - Decryption secret (must match encryption secret)
 * @returns {string|null} Plaintext password or null if decryption fails
 */
export const decryptBulkPassword = (ciphertext, secret) => {
    if (!ciphertext || !secret) return null;

    try {
        const algorithm = "aes-256-gcm";
        const parts = ciphertext.split(":");

        if (parts.length !== 3) {
            console.error("Invalid ciphertext format");
            return null;
        }

        const iv = Buffer.from(parts[0], "hex");
        const authTag = Buffer.from(parts[1], "hex");
        const encrypted = parts[2];

        // Derive key same way as encrypt
        let key;
        if (Buffer.byteLength(secret) === 32) {
            key = Buffer.from(secret);
        } else {
            key = crypto.createHash("sha256").update(secret).digest();
        }

        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, "hex", "utf8");
        decrypted += decipher.final("utf8");

        return decrypted;
    } catch (error) {
        console.error("Decryption error:", error.message);
        return null;
    }
};

// ===================================================================================
// Phase 5 — Fingerprint Template Encryption (AES-256-GCM)
// ===================================================================================
// These functions differ from encryptBulkPassword in three key ways:
//   1. They accept/return Buffer objects (not strings) — raw binary biometric data.
//   2. They use a 12-byte IV (the NIST-recommended length for GCM mode).
//   3. They reuse the global ENCRYPTION_KEY (validated to 32 bytes at module load).
// Decryption is called ONLY inside iotHubService.pushTemplatesToDevice().
// The encrypted fields are stored with select: false — never returned by any API.
// ===================================================================================

/**
 * Encrypt a raw fingerprint template Buffer using AES-256-GCM.
 * @function encryptFingerprintTemplate
 * @param {Buffer} templateBuffer - Raw 768-byte fingerprint template from R503 sensor.
 * @returns {{ ciphertext: string, iv: string, authTag: string }}
 *   ciphertext: base64-encoded encrypted template
 *   iv:         12-byte GCM IV as hex string
 *   authTag:    16-byte GCM auth tag as hex string
 */
export const encryptFingerprintTemplate = (templateBuffer) => {
    // 12-byte IV is the NIST recommended length for AES-GCM (96-bit nonce)
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(ENCRYPTION_KEY);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(templateBuffer),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
    };
};

/**
 * Decrypt an encrypted fingerprint template back to a raw Buffer.
 * Called only inside iotHubService — never in route handlers or controllers.
 * @function decryptFingerprintTemplate
 * @param {{ ciphertext: string, iv: string, authTag: string }} encrypted
 *   ciphertext: base64-encoded encrypted template (from templateData field)
 *   iv:         hex-encoded 12-byte IV (from templateIv field)
 *   authTag:    hex-encoded 16-byte auth tag (from templateAuthTag field)
 * @returns {Buffer} Raw fingerprint template bytes, ready to push to the R503.
 * @throws {Error} If authentication tag verification fails (tampered data).
 */
export const decryptFingerprintTemplate = ({ ciphertext, iv, authTag }) => {
    const key = Buffer.from(ENCRYPTION_KEY);
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
    ]);
};
