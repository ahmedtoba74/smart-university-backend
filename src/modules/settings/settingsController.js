/**
 * ===================================================================================
 * @file      settingsController.js
 * @desc      Controller for handling Settings API operations.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Settings/Controller
 */

import Settings from "../../../DB/models/settingsModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";

// ============================================
// IN-MEMORY SETTINGS CACHE
// ============================================

/**
 * Module-level cache for the Settings singleton.
 * Avoids a DB hit on every request that checks enrollment status,
 * credit limits, or grade points.
 *
 * Lifecycle:
 *  - Populated on first GET /settings call (lazy initialization).
 *  - Invalidated immediately after any PATCH /settings call.
 *  - No TTL needed — Settings only change when admin explicitly updates them.
 */
let _settingsCache = null;

/**
 * Returns the cached Settings document, or fetches it from DB on first call.
 * Use this in other controllers (e.g., enrollment) to avoid repeated DB reads.
 * @returns {Promise<Settings>}
 */
export const getSettingsCache = async () => {
    if (!_settingsCache) {
        _settingsCache = await Settings.getSettings();
    }
    return _settingsCache;
};

/**
 * Clears the in-memory cache.
 * Must be called after any PATCH /settings to keep cache consistent.
 */
export const invalidateSettingsCache = () => {
    _settingsCache = null;
};

// ============================================
// CONTROLLERS
// ============================================

const ALLOWED_UPDATE_FIELDS = [
    "currentAcademicYear",
    "currentSemester",
    "isEnrollmentOpen",
    "gradePoints",
    "defaultCreditLimit",
    "gradeThresholds",
    "levelThresholds",
    "chatTokenLimitByRole",
    "chatHistoryLimit",
    "chatMaxContextTokens",
    "chatMaxSummarizationCycles",
];

/**
 * GET /api/v1/settings
 * Returns the global system settings (singleton).
 * Accessible by all authenticated users — students/doctors need it
 * to check enrollment status and current semester.
 */
export const getSettings = catchAsync(async (req, res, next) => {
    const settings = await getSettingsCache();

    res.status(200).json({
        status: "success",
        data: { settings },
    });
});

/**
 * PATCH /api/v1/settings
 * Updates allowed settings fields.
 * Restricted to universityAdmin only.
 * Invalidates the in-memory cache after every successful update.
 */
export const updateSettings = catchAsync(async (req, res, next) => {
    const settings = await Settings.getSettings();

    // Whitelist: only update allowed fields, ignore everything else
    ALLOWED_UPDATE_FIELDS.forEach((field) => {
        if (req.body[field] !== undefined) {
            settings[field] = req.body[field];
        }
    });

    await settings.save();

    // Invalidate cache so next read fetches the updated document
    invalidateSettingsCache();

    res.status(200).json({
        status: "success",
        data: { settings },
    });
});
