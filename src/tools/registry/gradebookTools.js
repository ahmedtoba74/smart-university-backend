/**
 * ===================================================================================
 * @file      gradebookTools.js
 * @desc      Tier 3 gradebook tools — loaded for 'doctor' and 'ta' roles only.
 *            Contains:
 *            - getMyCourseOfferings        : Offerings where user is doctor or TA
 *            - getCourseGradebook          : All student grades for an assigned offering
 *            - getOfferingStudents         : Enrolled students for an assigned offering
 *            - getCourseAssessments        : Assessments for an assigned offering
 *            - getSubmissionsForAssessment : Student submissions for an assessment
 *            All tools enforce offering ownership: before returning any data,
 *            they verify the requesting user is in doctors_ids or tas_ids for
 *            the target CourseOffering. This prevents cross-course data access.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/tools/registry/gradebookTools
 */

import { z } from "zod";
import { objectIdSchema } from "../../utils/validationUtils.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import User from "../../../DB/models/userModel.js";
import Assessment from "../../../DB/models/assessmentModel.js";
import Submission from "../../../DB/models/submissionModel.js";

// ===================================================================================
// HELPER: verify doctor/TA assignment for an offering
// ===================================================================================

/**
 * Returns the offering if the user is assigned to it; null otherwise.
 * Used as the IDOR guard across all gradebook tools.
 *
 * @param {string} offeringId - CourseOffering ObjectId
 * @param {ObjectId} userId - Requesting user's _id
 * @returns {Promise<Object|null>}
 */
const findAssignedOffering = (offeringId, userId) =>
    CourseOffering.findOne({
        _id: offeringId,
        $or: [{ doctors_ids: userId }, { tas_ids: userId }],
    })
        .select("_id")
        .lean();

// ===================================================================================
// TOOL: getMyCourseOfferings
// ===================================================================================

/**
 * Returns all active course offerings where the doctor/TA is assigned.
 */
const getMyCourseOfferings = {
    name: "getMyCourseOfferings",
    label: "Checked your assigned courses",
    description:
        "Returns all course offerings that the doctor or TA is assigned to teach or assist with. Includes course name, code, semester, academic year, and enrollment count. Use this when the user asks about their courses, assigned sections, or teaching schedule.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const offerings = await CourseOffering.find({
            ...userContext.scopeFilter,
            $or: [
                { doctors_ids: userContext.user._id },
                { tas_ids: userContext.user._id },
            ],
        })
            .select(
                "course_id semester academicYear maxSeats currentEnrolled schedule resultsPublished semesterWorkLocked",
            )
            .populate("course_id", "code title creditHours")
            .lean();

        return JSON.stringify({
            count: offerings.length,
            offerings,
        });
    },
};

// ===================================================================================
// TOOL: getCourseGradebook
// ===================================================================================

/**
 * Returns all student grades for a specific course offering.
 * Verifies the doctor/TA is assigned to the offering before returning data.
 */
const getCourseGradebook = {
    name: "getCourseGradebook",
    label: "Checked the course gradebook",
    description:
        "Returns grade information for all students enrolled in a specific course offering. Includes each student's grade components and final results (if published). Use this when the doctor or TA asks about student grades or gradebook data for their course.",
    schema: z.object({
        courseOfferingId: objectIdSchema.describe(
            "The MongoDB ObjectId of the course offering.",
        ),
    }),
    execute: async (input, userContext) => {
        const offering = await findAssignedOffering(
            input.courseOfferingId,
            userContext.user._id,
        );
        if (!offering) {
            return JSON.stringify({
                error: "You are not authorized to view the gradebook for this offering.",
            });
        }

        const enrollments = await Enrollment.find({
            course_id: input.courseOfferingId,
            status: { $ne: "withdrawn" },
        })
            .select(
                "student_id snapshot grades status finalAttendancePercentage",
            )
            .populate("student_id", "name email")
            .lean();

        return JSON.stringify({
            count: enrollments.length,
            enrollments: enrollments.map((e) => ({
                student: {
                    _id: e.student_id?._id,
                    name: e.student_id?.name,
                    email: e.student_id?.email,
                },
                courseSnapshot: e.snapshot,
                status: e.status,
                finalAttendancePercentage: e.finalAttendancePercentage,
                grades: e.grades,
            })),
        });
    },
};

// ===================================================================================
// TOOL: getOfferingStudents
// ===================================================================================

/**
 * Returns the enrolled student roster for a specific course offering.
 * Verifies the doctor/TA is assigned to the offering before returning data.
 */
const getOfferingStudents = {
    name: "getOfferingStudents",
    label: "Checked the course roster",
    description:
        "Returns the list of students enrolled in a specific course offering. Includes student name, email, and enrollment status. Use this when the doctor or TA wants to see who is enrolled in their course.",
    schema: z.object({
        courseOfferingId: objectIdSchema.describe(
            "The MongoDB ObjectId of the course offering.",
        ),
    }),
    execute: async (input, userContext) => {
        const offering = await findAssignedOffering(
            input.courseOfferingId,
            userContext.user._id,
        );
        if (!offering) {
            return JSON.stringify({
                error: "You are not authorized to view the roster for this offering.",
            });
        }

        const enrollments = await Enrollment.find({
            course_id: input.courseOfferingId,
            status: { $ne: "withdrawn" },
        })
            .select("student_id snapshot status")
            .populate("student_id", "name email photo")
            .lean();

        return JSON.stringify({
            count: enrollments.length,
            students: enrollments.map((e) => ({
                student: {
                    _id: e.student_id?._id,
                    name: e.student_id?.name,
                    email: e.student_id?.email,
                    photo: e.student_id?.photo,
                },
                courseSnapshot: e.snapshot,
                status: e.status,
            })),
        });
    },
};

// ===================================================================================
// TOOL: getCourseAssessments
// ===================================================================================

/**
 * Returns all assessments for a specific course offering.
 * Verifies the doctor/TA is assigned to the offering before returning data.
 */
const getCourseAssessments = {
    name: "getCourseAssessments",
    label: "Checked the course assessments",
    description:
        "Returns all assessments (quizzes, assignments, exams) created for a specific course offering. Includes title, due date, total points, and submission statistics. Use this when the doctor or TA asks about assessments, quizzes, or grading tasks for their course.",
    schema: z.object({
        courseOfferingId: objectIdSchema.describe(
            "The MongoDB ObjectId of the course offering.",
        ),
    }),
    execute: async (input, userContext) => {
        const offering = await findAssignedOffering(
            input.courseOfferingId,
            userContext.user._id,
        );
        if (!offering) {
            return JSON.stringify({
                error: "You are not authorized to view assessments for this offering.",
            });
        }

        const assessments = await Assessment.find({
            courseOffering_id: input.courseOfferingId,
        })
            .select(
                "title description totalPoints dueDate timeLimitMinutes settings createdAt",
            )
            .sort({ dueDate: 1 })
            .lean();

        return JSON.stringify({
            count: assessments.length,
            assessments,
        });
    },
};

// ===================================================================================
// TOOL: getSubmissionsForAssessment
// ===================================================================================

/**
 * Returns all student submissions for a specific assessment.
 * Verifies the doctor/TA is assigned to the parent offering before returning data.
 */
const getSubmissionsForAssessment = {
    name: "getSubmissionsForAssessment",
    label: "Checked submissions for assessment",
    description:
        "Returns all student submissions for a specific assessment, including submission status, total score, and submission timestamp. Use this when the doctor or TA wants to review or grade student submissions for a quiz or assignment.",
    schema: z.object({
        assessmentId: objectIdSchema.describe(
            "The MongoDB ObjectId of the assessment.",
        ),
    }),
    execute: async (input, userContext) => {
        const assessment = await Assessment.findById(input.assessmentId)
            .select("courseOffering_id title totalPoints")
            .lean();

        if (!assessment) {
            return JSON.stringify({ error: "Assessment not found." });
        }

        const offering = await findAssignedOffering(
            assessment.courseOffering_id,
            userContext.user._id,
        );
        if (!offering) {
            return JSON.stringify({
                error: "You are not authorized to view submissions for this assessment.",
            });
        }

        const submissions = await Submission.find({
            assessment_id: input.assessmentId,
        })
            .select("student_id status totalScore submittedAt")
            .populate("student_id", "name email")
            .sort({ submittedAt: -1 })
            .lean();

        return JSON.stringify({
            assessmentTitle: assessment.title,
            totalPoints: assessment.totalPoints,
            count: submissions.length,
            submissions: submissions.map((s) => ({
                student: {
                    _id: s.student_id?._id,
                    name: s.student_id?.name,
                    email: s.student_id?.email,
                },
                status: s.status,
                totalScore: s.totalScore,
                submittedAt: s.submittedAt,
            })),
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [
    getMyCourseOfferings,
    getCourseGradebook,
    getOfferingStudents,
    getCourseAssessments,
    getSubmissionsForAssessment,
];
