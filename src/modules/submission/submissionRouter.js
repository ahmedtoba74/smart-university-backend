/**
 * ===================================================================================
 * @file      submissionRouter.js
 * @desc      Router for submission management endpoints (student answers, grading).
 *            Base path: /api/v1/submissions (NOT nested)
 * @module    modules/submission/submissionRouter
 * @requires  express, authMiddleware, submissionController
 * ===================================================================================
 */

import express from "express";
import {
    protect,
    restrictTo,
    attachCollegeScope,
} from "../../middleware/authMiddleware.js";
import * as submissionController from "./submissionController.js";

/**
 * Submission Router
 *
 * Base path: /api/v1/submissions
 * Handles student answer submission, grading workflow, and submission retrieval
 *
 * Note: NOT nested under offerings because submissions are queried
 * by assessment_id, not offeringId (though offeringId is available in body)
 *
 * Middleware Stack:
 * 1. protect - JWT authentication
 * 2. restrictTo - Role-based access control
 * 3. attachStaffScope - Validates staff belongs to course (grading routes only)
 */
const router = express.Router();

// ===========================================
// STUDENT ROUTES (Answer Submission Workflow)
// ===========================================

/**
 * @route   PATCH /api/v1/submissions/:submissionId/answers
 * @desc    Save or update student answers (draft mode)
 * @access  Students (owner only)
 * @body    { answers: [{ questionId, answerText?, selectedOptionId?, selectedOptionIds?, fileUrl? }] }
 * @note    Auto-submits if timer expired (returns { autoSubmitted: true })
 * @audit   D-4: Timer expiry check, force-submit with saved answers
 */
router.patch(
    "/:submissionId/answers",
    protect,
    restrictTo("student"),
    attachCollegeScope,
    submissionController.saveAnswers,
);

/**
 * @route   POST /api/v1/submissions/:submissionId/submit
 * @desc    Finalize submission (status: in_progress → submitted)
 * @access  Students (owner only)
 * @note    Auto-grades MCQ/TrueFalse, sets submittedAt timestamp
 * @audit   D-4: Timer expiry check, prevents late submission
 */
router.post(
    "/:submissionId/submit",
    protect,
    restrictTo("student"),
    attachCollegeScope,
    submissionController.submitAssessment,
);

/**
 * @route   GET /api/v1/submissions/:submissionId
 * @desc    Get a single submission (student or staff view)
 * @access  Students (owner), Doctors, TAs, College Admins
 * @note    Students can only see their own; staff can see all in their courses
 */
router.get(
    "/:submissionId",
    protect,
    restrictTo("student", "doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    submissionController.getSubmission,
);

// ===========================================
// STAFF ROUTES (Grading Workflow)
// ===========================================

/**
 * @route   GET /api/v1/submissions/assessment/:assessmentId
 * @desc    Get all submissions for an assessment (for grading interface)
 * @access  Doctors, TAs, College Admins
 * @query   ?status=submitted (optional filter)
 * @note    Returns full submission data including answers
 */
router.get(
    "/assessment/:assessmentId",
    protect,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    submissionController.getSubmissionsByAssessment,
);

/**
 * @route   PATCH /api/v1/submissions/:submissionId/grade
 * @desc    Manually grade a submission (Short-Answer, Paragraph, FileUpload)
 * @access  Doctors & TAs (must be assigned to course)
 * @body    { answers: [{ questionId, score, feedback? }] }
 * @note    Auto-calculates totalScore, triggers assignment grade recalc
 * @audit   D-23: Calls recalculateAssignmentGrade after grading
 */
router.patch(
    "/:submissionId/grade",
    protect,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    submissionController.gradeSubmission,
);

export default router;
