/**
 * ===================================================================================
 * @file      languageDetector.js
 * @desc      Server-side language detection for AI chatbot responses.
 *            Detects the language of the user's most recent message and injects a
 *            language instruction into the system prompt, ensuring the AI responds
 *            in the user's language while preserving technical terms and course codes.
 *            Uses franc-min v6+ which is ESM-native — no createRequire needed.
 * @module    src/utils/languageDetector
 * @requires  franc-min
 * ===================================================================================
 */

import { franc } from "franc-min";

/**
 * Maps franc ISO 639-3 language codes to human-readable language names
 * for injection into the AI system prompt.
 */
const LANGUAGE_MAP = {
    ara: "Arabic",
    eng: "English",
    fra: "French",
    deu: "German",
    spa: "Spanish",
};

/**
 * Detects the primary language of the provided text.
 * Returns "English" as the default for very short messages (< 10 chars)
 * because franc-min cannot reliably detect language from single words or greetings.
 *
 * @function detectLanguage
 * @param {string} text - The user's message text.
 * @returns {string} Human-readable language name (e.g., "Arabic", "English").
 */
export const detectLanguage = (text) => {
    if (!text || text.trim().length < 10) {
        return "English"; // Default for very short messages - franc unreliable below ~10 chars
    }
    const detected = franc(text, { minLength: 5 });
    return LANGUAGE_MAP[detected] ?? "English"; // Default to English if undetected/ambiguous
};
