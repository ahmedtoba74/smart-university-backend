/**
 * ===================================================================================
 * @file      announcementTools.js
 * @desc      Tier 1 announcement tools — available to all authenticated roles.
 *            Contains getAnnouncements.
 *            SECURITY: getAnnouncements MUST call buildVisibilityFilter(user)
 *            from announcementUtils.js before querying. Querying Announcement.find({})
 *            without this filter would leak announcements across role and college
 *            boundaries. The filter enforces:
 *            - Role-specific scope (Global/College/Department/Course)
 *            - Enrollment-based filtering for students
 *            - Assigned course filtering for doctors/TAs
 *            - College-scoped access for collegeAdmins
 *            - Unrestricted access for universityAdmin
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/tools/registry/announcementTools
 */

import { z } from "zod";
import Announcement from "../../../DB/models/announcementModel.js";
import { buildVisibilityFilter } from "../../utils/announcementUtils.js";

// ===================================================================================
// TOOL: getAnnouncements
// ===================================================================================

/**
 * Returns visible announcements for the requesting user's scope.
 * Enforces role-scoped visibility using buildVisibilityFilter from
 * announcementUtils.js — the same logic used by the REST controller (Phase 6).
 *
 * Available to all authenticated roles (Tier 1).
 */
const getAnnouncements = {
    name: "getAnnouncements",
    label: "Checked announcements",
    description:
        "Returns the most recent announcements visible to the current user based on their role and enrolled courses. Use this when the user asks about announcements, news, notifications, or updates relevant to them.",
    schema: z.object({
        limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .default(10)
            .describe(
                "Maximum number of announcements to return (1–20, default 10).",
            ),
    }),
    execute: async (input, userContext) => {
        const visibilityFilter = await buildVisibilityFilter(userContext.user);
        const announcements = await Announcement.find(visibilityFilter)
            .select("title content scope createdAt")
            .sort({ createdAt: -1 })
            .limit(input.limit)
            .lean();

        return JSON.stringify({
            count: announcements.length,
            announcements,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [getAnnouncements];
