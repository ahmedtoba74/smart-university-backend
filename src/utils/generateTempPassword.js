/**
 * ===================================================================================
 * @file      generateTempPassword.js
 * @desc      Utility for generating cryptographically secure temporary passwords.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/GenerateTempPassword
 */
import crypto from "crypto";

/**
 * Generates a secure random 10-character minimum password containing at least
 * one uppercase, one lowercase, one digit, and one special symbol.
 * Uses `crypto.randomInt` for high entropy.
 * @function generateTempPassword
 * @returns {string} The cryptographically secure generated password
 */
export const generateTempPassword = () => {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const digits = "0123456789";
    const symbols = "@$!%*?_#-";
    const all = upper + lower + digits + symbols;

    // Guarantee at least one character from EACH category
    const password = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        symbols[crypto.randomInt(symbols.length)],
        // 6 additional fully random characters
        ...Array.from({ length: 6 }, () => all[crypto.randomInt(all.length)]),
    ];

    // Shuffle to prevent predictable category-position patterns
    return password.sort(() => crypto.randomInt(3) - 1).join("");
};
