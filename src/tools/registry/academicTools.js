/**
 * ===================================================================================
 * @file      academicTools.js
 * @desc      Tier 2 student academic record tools — loaded for the 'student' role only.
 *
 *            Contains:
 *              - getMyEnrollments    : Current and historical enrollments
 *              - getMyGrades         : Grades per enrollment with resultsPublished guard
 *              - getMyAssessments    : Assessments for enrolled courses with submission status
 *              - getMySubmission     : A specific submission with showGradesImmediately guard
 *              - getAvailableCourses : Course offerings available in the student's college
 *
 *            Business Rules Enforced:
 *              - getMyGrades: Never exposes finalTotal / finalLetter when the
 *                parent CourseOffering.resultsPublished === false. This mirrors
 *                the Phase 5 gradebook controller exactly.
 *              - getMySubmission: Strips answers[].score and totalScore when
 *                Assessment.settings.showGradesImmediately === false.
 *                This mirrors the Phase 5 submission controller exactly.
 *
 * @module    src/tools/registry/academicTools
 * @requires  zod
 * @requires  ../../../DB/models/enrollmentModel
 * @requires  ../../../DB/models/courseOfferingModel
 * @requires  ../../../DB/models/courseCatalogModel
 * @requires  ../../../DB/models/assessmentModel
 * @requires  ../../../DB/models/submissionModel
 * ===================================================================================
 */

import { z } from "zod";
import { objectIdSchema } from "../../utils/validationUtils.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import CourseCatalog from "../../../DB/models/courseCatalogModel.js";
import Assessment from "../../../DB/models/assessmentModel.js";
import Submission from "../../../DB/models/submissionModel.js";

// ===================================================================================
// TOOL: getMyEnrollments
// ===================================================================================

/**
 * Returns all enrollments for the authenticated student, including course snapshot data.
 * IDOR: queries only on student_id === userContext.user._id.
 */
const getMyEnrollments = {
    name: "getMyEnrollments",
    label: "Checked your enrollments",
    description:
        "Returns the student's current and historical course enrollments including course code, title, credit hours, semester, academic year, and enrollment status. Use this when the user asks about their courses, enrolled subjects, or academic history.",
    schema: z.object({
        status: z
            .enum(["enrolled", "passed", "failed", "withdrawn", "all"])
            .optional()
            .default("all")
            .describe(
                "Filter enrollments by status. Use 'all' to return every enrollment.",
            ),
    }),
    execute: async (input, userContext) => {
        const filter = {
            student_id: userContext.user._id,
        };
        if (input.status !== "all") {
            filter.status = input.status;
        }

        const enrollments = await Enrollment.find(filter)
            .select(
                "course_id catalogCourse_id semester academicYear status snapshot finalAttendancePercentage",
            )
            .sort({ createdAt: -1 })
            .lean();

        return JSON.stringify({
            count: enrollments.length,
            enrollments,
        });
    },
};

// ===================================================================================
// TOOL: getMyGrades
// ===================================================================================

/**
 * Returns grade components for each of the student's enrollments.
 *
 * BUSINESS RULE: If the parent CourseOffering.resultsPublished is false,
 * grades.finalTotal and grades.finalLetter are set to null in the response.
 * This prevents students from seeing unpublished final grades through the chatbot
 * that are hidden in the Phase 5 REST API.
 */
const getMyGrades = {
    name: "getMyGrades",
    label: "Checked your grades",
    description:
        "Returns the student's grades across all enrolled courses, including attendance, midterm, assignments, project, and final exam scores. Final total and letter grades are only shown after results are officially published. Use this when the user asks about their grades, scores, GPA components, or academic performance.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const enrollments = await Enrollment.find({
            student_id: userContext.user._id,
        })
            .select(
                "course_id semester academicYear status snapshot grades finalAttendancePercentage",
            )
            .populate("course_id", "resultsPublished")
            .lean();

        const gradesData = enrollments.map((enrollment) => {
            const resultsPublished =
                enrollment.course_id?.resultsPublished ?? false;

            const grades = { ...enrollment.grades };

            // Enforce business rule: strip final results when not yet published
            if (!resultsPublished) {
                grades.finalTotal = null;
                grades.finalLetter = null;
            }

            return {
                courseSnapshot: enrollment.snapshot,
                semester: enrollment.semester,
                academicYear: enrollment.academicYear,
                status: enrollment.status,
                finalAttendancePercentage: enrollment.finalAttendancePercentage,
                resultsPublished,
                grades,
            };
        });

        return JSON.stringify({
            count: gradesData.length,
            grades: gradesData,
        });
    },
};

// ===================================================================================
// TOOL: getMyAssessments
// ===================================================================================

/**
 * Returns assessments for courses the student is actively enrolled in,
 * along with submission status for each.
 */
const getMyAssessments = {
    name: "getMyAssessments",
    label: "Checked your assessments",
    description:
        "Returns upcoming and past assessments for all courses the student is currently enrolled in. Includes due dates, total points, and whether the student has submitted. Use this when the user asks about quizzes, assignments, exams, or homework.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const enrollments = await Enrollment.find({
            student_id: userContext.user._id,
            status: "enrolled",
        })
            .select("course_id")
            .lean();

        const offeringIds = enrollments.map((e) => e.course_id);

        const [assessments, submissions] = await Promise.all([
            Assessment.find({
                courseOffering_id: { $in: offeringIds },
            })
                .select(
                    "title description courseOffering_id totalPoints dueDate timeLimitMinutes settings.acceptingResponses",
                )
                .sort({ dueDate: 1 })
                .lean(),
            Submission.find({
                student_id: userContext.user._id,
                courseOffering_id: { $in: offeringIds },
            })
                .select("assessment_id status submittedAt")
                .lean(),
        ]);

        // Map submission status by assessment ID for O(1) lookup
        const submissionMap = new Map(
            submissions.map((s) => [s.assessment_id.toString(), s]),
        );

        const assessmentData = assessments.map((a) => ({
            _id: a._id,
            title: a.title,
            description: a.description,
            courseOffering_id: a.courseOffering_id,
            totalPoints: a.totalPoints,
            dueDate: a.dueDate,
            timeLimitMinutes: a.timeLimitMinutes,
            acceptingResponses: a.settings?.acceptingResponses,
            submission: submissionMap.get(a._id.toString()) ?? null,
        }));

        return JSON.stringify({
            count: assessmentData.length,
            assessments: assessmentData,
        });
    },
};

// ===================================================================================
// TOOL: getMySubmission
// ===================================================================================

/**
 * Returns a specific student submission and its per-question scores.
 *
 * BUSINESS RULE: If Assessment.settings.showGradesImmediately is false,
 * answers[].score and totalScore are stripped from the response. This mirrors
 * the Phase 5 submission controller to prevent students from seeing hidden scores
 * through the chatbot.
 *
 * IDOR: queries on student_id === userContext.user._id.
 */
const getMySubmission = {
    name: "getMySubmission",
    label: "Checked your submission",
    description:
        "Returns the details of a specific submission for a given assessment, including answers and scores if grades have been released. Use this when the user wants to check a specific quiz result, submission status, or their score on a particular assessment.",
    schema: z.object({
        assessmentId: objectIdSchema.describe(
            "The MongoDB ObjectId of the assessment to retrieve the submission for.",
        ),
    }),
    execute: async (input, userContext) => {
        const submission = await Submission.findOne({
            assessment_id: input.assessmentId,
            student_id: userContext.user._id,
        })
            .populate(
                "assessment_id",
                "title totalPoints settings.showGradesImmediately",
            )
            .lean();

        if (!submission) {
            return JSON.stringify({
                error: "Submission not found for this assessment.",
            });
        }

        const showGrades =
            submission.assessment_id?.settings?.showGradesImmediately ?? false;

        const result = {
            _id: submission._id,
            assessmentTitle: submission.assessment_id?.title,
            totalPoints: submission.assessment_id?.totalPoints,
            status: submission.status,
            submittedAt: submission.submittedAt,
            totalScore: showGrades ? submission.totalScore : null,
            answers: submission.answers.map((a) => ({
                questionId: a.questionId,
                answerText: a.answerText,
                selectedOptionId: a.selectedOptionId,
                selectedOptionIds: a.selectedOptionIds,
                score: showGrades ? a.score : null,
                feedback: showGrades ? a.feedback : null,
            })),
        };

        return JSON.stringify(result);
    },
};

// ===================================================================================
// TOOL: getAvailableCourses
// ===================================================================================

/**
 * Returns course offerings available in the current semester in the student's college.
 * Populated with catalog information for course name and code.
 */
const getAvailableCourses = {
    name: "getAvailableCourses",
    label: "Checked available courses",
    description:
        "Returns course offerings available for enrollment in the current semester within the student's college. Includes course name, code, credit hours, available seats, and schedule. Use this when the user asks about available courses, what they can enroll in, or course schedules.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const settings = await import(
            "../../../DB/models/settingsModel.js"
        ).then((m) => m.default.getSettings());

        const filter = {
            ...userContext.scopeFilter,
            semester: settings.currentSemester,
            academicYear: settings.currentAcademicYear,
        };

        const offerings = await CourseOffering.find(filter)
            .select(
                "course_id semester academicYear maxSeats currentEnrolled schedule totalDegree gradingPolicy",
            )
            .populate(
                "course_id",
                "courseCode courseTitle creditHours department_id",
            )
            .lean();

        return JSON.stringify({
            count: offerings.length,
            semester: settings.currentSemester,
            academicYear: settings.currentAcademicYear,
            offerings,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [
    getMyEnrollments,
    getMyGrades,
    getMyAssessments,
    getMySubmission,
    getAvailableCourses,
];
