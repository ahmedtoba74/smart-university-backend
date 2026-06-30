/**
 * ===================================================================================
 * @file      otpUtils.js
 * @desc      Utility for generating cryptographically secure OTPs containing letters, digits, and symbols.
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/OtpUtils
 */

import crypto from "crypto";

/**
 * Generates a secure random 8-character OTP containing at least
 * one uppercase, one lowercase, one digit, and one safe symbol.
 * Uses `crypto.randomInt` for cryptographic security.
 * Uses Fisher-Yates shuffle to prevent predictable category-position patterns.
 * 
 * @function generateOTP
 * @param {number} [length=8] - The length of the OTP (minimum 4).
 * @returns {string} The cryptographically secure generated OTP.
 */
export const generateOTP = (length = 8) => {
    if (length < 4) {
        throw new Error("OTP length must be at least 4 characters to guarantee category diversity.");
    }

    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const digits = "0123456789";
    const symbols = "@!*_-"; // Avoids sensitive symbols like $, %, ?, # to prevent HTML/URL/template errors
    const all = upper + lower + digits + symbols;

    // Guarantee at least one character from each required category
    const otpParts = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        symbols[crypto.randomInt(symbols.length)],
    ];

    // Fill the remaining length with random characters from the combined set
    for (let i = 4; i < length; i++) {
        otpParts.push(all[crypto.randomInt(all.length)]);
    }

    // Securely shuffle using Fisher-Yates algorithm
    for (let i = otpParts.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        const temp = otpParts[i];
        otpParts[i] = otpParts[j];
        otpParts[j] = temp;
    }

    return otpParts.join("");
};
