/**
 * ===================================================================================
 * @file      announcementUtils.js
 * @desc      Shared utilities for the Announcements module.
 *            Consolidates visibility filter construction and periodic expiration tasks.
 *
 *            Specifically, `buildVisibilityFilter` was extracted from the
 *            announcement controller to prevent code drift and ensure role-scoped
 *            tenant boundary compliance is evaluated identically across:
 *              - Announcement REST controller endpoints (Phase 6)
 *              - AI Chatbot Engine tool registry (Phase 7)
 *
 *            The `expireAnnouncements` function handles periodic cleanup of expired
 *            announcements, called by scheduled maintenance jobs in server.js.
 * @module    src/utils/announcementUtils
 * @requires  ../../DB/models/announcementModel
 * @requires  ../../DB/models/courseOfferingModel
 * @requires  ../../DB/models/departmentModel
 * @requires  ../../DB/models/enrollmentModel
 * ===================================================================================
 */

// ===================================================================================
// IMPORTS
// ===================================================================================
import Announcement from "../../DB/models/announcementModel.js";
import CourseOffering from "../../DB/models/courseOfferingModel.js";
import Department from "../../DB/models/departmentModel.js";
import Enrollment from "../../DB/models/enrollmentModel.js";

// ===================================================================================
// VISIBILITY UTILITIES
// ===================================================================================

/**
 * Builds the role-specific MongoDB visibility filter for a given user.
 *
 * Security notes:
 * - collegeAdmin: Both Department and CourseOffering sub-queries bypass the
 *   isArchived pre-find hook to include historical announcements for moderation.
 * - doctor/ta: CourseOffering sub-query bypasses isArchived to include historical
 *   course announcements from past semesters.
 * - student/doctor/ta: College and Department $or clauses are only added when the
 *   corresponding field exists on user (guards against null casting).
 *
 * @async
 * @function buildVisibilityFilter
 * @param {Object} user - The requesting user context (req.user)
 * @returns {Promise<Object>} MongoDB query filter object
 */
export const buildVisibilityFilter = async (user) => {
    // University admin sees everything
    if (user.role === "universityAdmin") {
        return {};
    }

    if (user.role === "collegeAdmin") {
        // Bypass pre-find hook on both queries to include archived entities.
        // A collegeAdmin must be able to moderate historical announcements
        // even after a department or course offering has been archived.
        const [depts, offerings] = await Promise.all([
            Department.find({
                college_id: user.college_id,
                isArchived: { $in: [true, false] },
            })
                .select("_id")
                .lean(),
            CourseOffering.find({
                college_id: user.college_id,
                isArchived: { $in: [true, false] },
            })
                .select("_id")
                .lean(),
        ]);

        const deptIds = depts.map((d) => d._id);
        const offeringIds = offerings.map((o) => o._id);

        return {
            $or: [
                { "scope.level": "Global" },
                { "scope.level": "College", "scope.target": user.college_id },
                {
                    "scope.level": "Department",
                    "scope.target": { $in: deptIds },
                },
                {
                    "scope.level": "Course",
                    "scope.target": { $in: offeringIds },
                },
            ],
        };
    }

    if (user.role === "student") {
        const enrollments = await Enrollment.find({
            student_id: user._id,
            // Include active and historical enrollments so students can access
            // announcements from courses they have already completed or failed.
            status: { $in: ["enrolled", "passed", "failed"] },
        })
            .select("course_id")
            .lean();

        const enrolledOfferingIds = enrollments.map((e) => e.course_id);

        // Build $or dynamically — only add college/dept clauses if fields exist
        const orClauses = [{ "scope.level": "Global" }];
        if (user.college_id) {
            orClauses.push({
                "scope.level": "College",
                "scope.target": user.college_id,
            });
        }
        if (user.department_id) {
            orClauses.push({
                "scope.level": "Department",
                "scope.target": user.department_id,
            });
        }
        orClauses.push({
            "scope.level": "Course",
            "scope.target": { $in: enrolledOfferingIds },
        });

        return { $or: orClauses };
    }

    if (user.role === "doctor" || user.role === "ta") {
        // Bypass pre-find hook to include archived offerings.
        // A teacher should still see their historical course announcements
        // even after a semester ends and the offering is archived.
        const offerings = await CourseOffering.find({
            isArchived: { $in: [true, false] },
            $or: [{ doctors_ids: user._id }, { tas_ids: user._id }],
        })
            .select("_id")
            .lean();

        const assignedOfferingIds = offerings.map((o) => o._id);

        // Build $or dynamically
        const orClauses = [{ "scope.level": "Global" }];
        if (user.college_id) {
            orClauses.push({
                "scope.level": "College",
                "scope.target": user.college_id,
            });
        }
        if (user.department_id) {
            orClauses.push({
                "scope.level": "Department",
                "scope.target": user.department_id,
            });
        }
        orClauses.push({
            "scope.level": "Course",
            "scope.target": { $in: assignedOfferingIds },
        });

        return { $or: orClauses };
    }

    // Safety net: unknown role sees nothing
    return { _id: null };
};

// ===================================================================================
// MAINTENANCE UTILITIES
// ===================================================================================

/**
 * Soft-deletes all active announcements whose `expiresAt` timestamp has passed.
 * Uses `updateMany` which bypasses the pre-find query hook intentionally —
 * this IS the cleanup mechanism; it targets documents not yet archived.
 *
 * This function is designed to be called periodically (e.g. every hour) from
 * server.js. It mirrors the `expireDueSessions` pattern from attendanceUtils.js.
 *
 * Safety: only targets documents where:
 *   - expiresAt is not null ($ne null)
 *   - expiresAt is in the past ($lte now)
 *   - isArchived is still false (not already soft-deleted)
 *
 * @async
 * @function expireAnnouncements
 * @returns {Promise<void>}
 */
export const expireAnnouncements = async () => {
    const result = await Announcement.updateMany(
        {
            expiresAt: { $ne: null, $lte: new Date() },
            isArchived: false,
        },
        { isArchived: true },
    );

    if (result.modifiedCount > 0) {
        console.log(
            `[AnnouncementCleanup] Soft-deleted ${result.modifiedCount} expired announcement(s) at ${new Date().toISOString()}.`,
        );
    }
};
