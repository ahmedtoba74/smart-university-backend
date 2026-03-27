/**
 * ===================================================================================
 * @file      timeConflict.js
 * @desc      Utility functions for detecting schedule overlap and time collisions.
 *            Used by Phase 3 Enrollment Engine (Gate 5) and Course Offering modules.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 */

/**
 * Converts a string representing a time in HH:MM format (24-hour) into
 * the total number of minutes elapsed since midnight.
 *
 * @example
 * // returns 870
 * timeToMinutes("14:30");
 *
 * @example
 * // returns 540
 * timeToMinutes("09:00");
 *
 * @param {string} timeStr - Time string in "HH:MM" format. Must be zero-padded appropriately.
 * @returns {number} The total minutes elapsed since 00:00 (midnight).
 * @throws {Error} Throws if the input is not a valid string or split fails.
 */
export const timeToMinutes = (timeStr) => {
    if (typeof timeStr !== "string" || !timeStr.includes(":")) {
        throw new Error(
            `Invalid time format provided to timeToMinutes: ${timeStr}`,
        );
    }
    const [hours, minutes] = timeStr.split(":").map(Number);
    return hours * 60 + minutes;
};

/**
 * Detects if two time slots overlap based strictly on their start and end times.
 * This function assumes both slots occur on the SAME DAY. A day check must be
 * performed by the caller before invoking this utility.
 *
 * **Business Logic Rule:**
 * A strict overlap occurs only if `(Start A < End B) AND (End A > Start B)`.
 * Back-to-back classes are NOT considered overlapping. For instance, a class
 * ending at 11:30 and another starting at 11:30 do not conflict.
 *
 * @example
 * // returns true
 * hasTimeOverlap(
 *   { startTime: "10:00", endTime: "12:00" },
 *   { startTime: "11:00", endTime: "13:00" }
 * );
 *
 * @example
 * // returns false (back-to-back classes)
 * hasTimeOverlap(
 *   { startTime: "10:00", endTime: "11:30" },
 *   { startTime: "11:30", endTime: "13:00" }
 * );
 *
 * @param {Object} slotA - The first schedule slot to compare.
 * @param {string} slotA.startTime - The start time of slot A in "HH:MM".
 * @param {string} slotA.endTime - The end time of slot A in "HH:MM".
 * @param {Object} slotB - The second schedule slot to compare.
 * @param {string} slotB.startTime - The start time of slot B in "HH:MM".
 * @param {string} slotB.endTime - The end time of slot B in "HH:MM".
 * @returns {boolean} `true` if the times strictly overlap, `false` otherwise.
 */
export const hasTimeOverlap = (slotA, slotB) => {
    const startA = timeToMinutes(slotA.startTime);
    const endA = timeToMinutes(slotA.endTime);

    const startB = timeToMinutes(slotB.startTime);
    const endB = timeToMinutes(slotB.endTime);

    // Strict overlap: if one ends exactly when the other starts, they do NOT overlap.
    return startA < endB && endA > startB;
};
