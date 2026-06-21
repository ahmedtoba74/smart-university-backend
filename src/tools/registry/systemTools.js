/**
 * ===================================================================================
 * @file      systemTools.js
 * @desc      Tier 5 system tools — loaded for the 'universityAdmin' role only.
 *
 *            Contains:
 *              - getAllColleges               : All colleges with counts
 *              - getUniversityEnrollmentStats : Enrollment counts across all colleges
 *              - getUserById                 : Any user's profile by ID
 *              - getSystemSettings           : Full Settings singleton
 *
 *            Security notes:
 *              - universityAdmin scopeFilter is {} (unrestricted), matching
 *                how attachCollegeScope sets it for this role in the REST layer.
 *                The chatbot inherits this behavior identically.
 *              - getUserById uses an explicit .select() projection — security-sensitive
 *                fields (loginAttempts, lockoutStage, lockUntil, twoFactorSecret,
 *                passwordResetToken) are NEVER returned.
 *              - getAllColleges: the College model has an isArchived pre-find hook
 *                that auto-filters archived colleges from standard queries.
 *
 * @module    src/tools/registry/systemTools
 * @requires  zod
 * @requires  ../../../DB/models/collegeModel
 * @requires  ../../../DB/models/enrollmentModel
 * @requires  ../../../DB/models/userModel
 * @requires  ../../../DB/models/settingsModel
 * ===================================================================================
 */

import { z } from "zod";
import { objectIdSchema } from "../../utils/validationUtils.js";
import College from "../../../DB/models/collegeModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import User from "../../../DB/models/userModel.js";
import Settings from "../../../DB/models/settingsModel.js";

// ===================================================================================
// TOOL: getAllColleges
// ===================================================================================

/**
 * Returns all non-archived colleges in the university.
 * The College model's pre-find hook auto-filters isArchived: false unless
 * explicitly overridden. No manual filter needed.
 */
const getAllColleges = {
    name: "getAllColleges",
    label: "Checked all colleges",
    description:
        "Returns all active colleges in the university with their department and student counts. Use this when the university admin asks about colleges, university structure, or institutional overview.",
    schema: z.object({}),
    execute: async (_input, _userContext) => {
        const [colleges, departmentCounts, userCounts] = await Promise.all([
            College.find({}).select("name").lean(),
            // Count departments per college using aggregate to avoid N+1 queries
            import("../../../DB/models/departmentModel.js").then((m) =>
                m.default.aggregate([
                    { $group: { _id: "$college_id", count: { $sum: 1 } } },
                ]),
            ),
            // Count active students per college
            User.aggregate([
                { $match: { role: "student", active: true } },
                { $group: { _id: "$college_id", count: { $sum: 1 } } },
            ]),
        ]);

        const deptMap = new Map(
            departmentCounts.map((d) => [d._id.toString(), d.count]),
        );
        const userMap = new Map(
            userCounts.map((u) => [u._id.toString(), u.count]),
        );

        const result = colleges.map((c) => ({
            _id: c._id,
            name: c.name,
            departmentCount: deptMap.get(c._id.toString()) ?? 0,
            studentCount: userMap.get(c._id.toString()) ?? 0,
        }));

        return JSON.stringify({
            count: colleges.length,
            colleges: result,
        });
    },
};

// ===================================================================================
// TOOL: getUniversityEnrollmentStats
// ===================================================================================

/**
 * Returns enrollment counts aggregated across all colleges in the university.
 */
const getUniversityEnrollmentStats = {
    name: "getUniversityEnrollmentStats",
    label: "Checked university enrollment statistics",
    description:
        "Returns enrollment statistics aggregated across all colleges in the university. Shows total enrollments, breakdowns by status, and per-college counts. Use this when the university admin asks about university-wide enrollment numbers or academic statistics.",
    schema: z.object({}),
    execute: async (_input, _userContext) => {
        const stats = await Enrollment.aggregate([
            {
                $group: {
                    _id: {
                        college_id: "$college_id",
                        status: "$status",
                    },
                    count: { $sum: 1 },
                },
            },
            {
                $group: {
                    _id: "$_id.college_id",
                    statusBreakdown: {
                        $push: {
                            status: "$_id.status",
                            count: "$count",
                        },
                    },
                    totalEnrollments: { $sum: "$count" },
                },
            },
            { $sort: { totalEnrollments: -1 } },
        ]);

        const totalAcrossUniversity = stats.reduce(
            (sum, s) => sum + s.totalEnrollments,
            0,
        );

        return JSON.stringify({
            totalEnrollmentsUniversity: totalAcrossUniversity,
            byCollege: stats,
        });
    },
};

// ===================================================================================
// TOOL: getUserById
// ===================================================================================

/**
 * Returns any user's profile by ID using an explicit .select() projection.
 * Security-sensitive fields are NEVER returned.
 */
const getUserById = {
    name: "getUserById",
    label: "Looked up a user",
    description:
        "Returns a specific user's profile information by their ID. Use this when the university admin needs to look up a specific user's details such as their name, role, email, or academic status.",
    schema: z.object({
        userId: objectIdSchema.describe(
            "The MongoDB ObjectId of the user to look up.",
        ),
    }),
    execute: async (input, _userContext) => {
        const user = await User.findById(input.userId)
            .select(
                "name role email college_id department_id level gpa academicStatus photo active createdAt",
            )
            .lean();

        if (!user) {
            return JSON.stringify({ error: "User not found." });
        }

        return JSON.stringify(user);
    },
};

// ===================================================================================
// TOOL: getSystemSettings
// ===================================================================================

/**
 * Returns the full Settings singleton including chat configuration and academic settings.
 */
const getSystemSettings = {
    name: "getSystemSettings",
    label: "Checked system settings",
    description:
        "Returns the full system configuration including current semester, academic year, enrollment status, grading thresholds, credit limits, and chat token limits per role. Use this when the university admin asks about system configuration or settings.",
    schema: z.object({}),
    execute: async (_input, _userContext) => {
        const settings = await Settings.getSettings();
        return JSON.stringify({
            currentAcademicYear: settings.currentAcademicYear,
            currentSemester: settings.currentSemester,
            isEnrollmentOpen: settings.isEnrollmentOpen,
            defaultCreditLimit: settings.defaultCreditLimit,
            chatTokenLimitByRole: settings.chatTokenLimitByRole,
            chatHistoryLimit: settings.chatHistoryLimit,
            chatMaxContextTokens: settings.chatMaxContextTokens,
            chatMaxSummarizationCycles: settings.chatMaxSummarizationCycles,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [
    getAllColleges,
    getUniversityEnrollmentStats,
    getUserById,
    getSystemSettings,
];
