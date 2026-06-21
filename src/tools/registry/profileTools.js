/**
 * ===================================================================================
 * @file      profileTools.js
 * @desc      Tier 1 profile tools — available to all authenticated roles.
 *            Contains getSystemInfo and getMyProfile.
 *
 *            getMyProfile uses an explicit .select() projection to return
 *            only safe, non-sensitive user fields. The raw userContext.user
 *            object is NEVER returned — it contains security fields such as
 *            loginAttempts, lockoutStage, lockUntil, twoFactorSecret,
 *            and passwordResetToken.
 *
 * @module    src/tools/registry/profileTools
 * @requires  zod
 * @requires  ../../../DB/models/settingsModel
 * @requires  ../../../DB/models/userModel
 * ===================================================================================
 */

import { z } from "zod";
import Settings from "../../../DB/models/settingsModel.js";
import User from "../../../DB/models/userModel.js";

// ===================================================================================
// TOOL: getSystemInfo
// ===================================================================================

/**
 * Returns current academic settings: semester, academic year, and enrollment status.
 * Available to all authenticated roles (Tier 1).
 */
const getSystemInfo = {
    name: "getSystemInfo",
    label: "Checked system settings",
    description:
        "Returns current system information including the active semester, academic year, and whether enrollment is currently open. Use this when the user asks about the current semester, academic calendar, or enrollment status.",
    schema: z.object({}),
    execute: async (_input, _userContext) => {
        const settings = await Settings.getSettings();
        return JSON.stringify({
            currentAcademicYear: settings.currentAcademicYear,
            currentSemester: settings.currentSemester,
            isEnrollmentOpen: settings.isEnrollmentOpen,
        });
    },
};

// ===================================================================================
// TOOL: getMyProfile
// ===================================================================================

/**
 * Returns the authenticated user's own profile fields using an explicit .select()
 * projection. Never returns security-sensitive fields from the User document.
 * Available to all authenticated roles (Tier 1).
 *
 * Projected fields: name, role, email, college_id, department_id, level,
 *                   gpa, academicStatus, photo
 */
const getMyProfile = {
    name: "getMyProfile",
    label: "Checked your profile",
    description:
        "Returns the current user's profile information such as name, role, email, college, department, GPA, academic level, and academic status. Use this when the user asks about their own profile, GPA, academic standing, or identity.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const profile = await User.findById(userContext.user._id)
            .select(
                "name role email college_id department_id level gpa academicStatus photo",
            )
            .lean();

        if (!profile) {
            return JSON.stringify({ error: "Profile not found." });
        }

        return JSON.stringify(profile);
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [getSystemInfo, getMyProfile];
