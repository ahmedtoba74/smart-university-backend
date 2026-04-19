/**
 * ===================================================================================
 * @file      assessmentRouter.js
 * @desc      Router for assessment management endpoints (quizzes, exams, assignments).
 *            Nested under /api/v1/offerings/:offeringId/assessments
 * @module    modules/assessment/assessmentRouter
 * @requires  express, authMiddleware, assessmentController
 * ===================================================================================
 */

import express from "express";
import {
    protect,
    restrictTo,
    attachStaffScope,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import * as assessmentController from "./assessmentController.js";

/**
 * Assessment Router
 *
 * Base path: /api/v1/course-offerings/:offeringId/assessments
 * Handles CRUD operations for assessments and student access workflows
 *
 * Route Parameters:
 * @param {string} offeringId - Course offering ID (from parent router)
 *
 * Middleware Stack:
 * 1. protect - JWT authentication
 * 2. restrictTo - Role-based access control
 * 3. attachStaffScope - Validates staff belongs to course (doctor/TA routes only)
 */
const router = express.Router({ mergeParams: true });

// ===========================================
// STAFF ROUTES (Doctors & TAs)
// ===========================================

/**
 * @route   POST /api/v1/course-offerings/:offeringId/assessments
 * @desc    Create a new assessment
 * @access  Doctors & TAs (must be assigned to course)
 * @body    { title, description, dueDate, timeLimitMinutes?, questions[], settings? }
 */
router.post(
    "/",
    protect,
    restrictTo("doctor"),
    attachCollegeScope,
    assessmentController.createAssessment,
);

/**
 * @route   GET /api/v1/course-offerings/:offeringId/assessments
 * @desc    Get all assessments for a course offering
 * @access  Doctors, TAs, Students (enrolled), College Admins
 * @note    Students see limited fields (no isCorrect, modelAnswer)
 */
router.get(
    "/",
    protect,
    restrictTo("doctor", "ta", "student", "collegeAdmin"),
    attachCollegeScope,
    assessmentController.getAllAssessments,
);

/**
 * @route   GET /api/v1/course-offerings/:offeringId/assessments/:id
 * @desc    Get a single assessment by ID (with question security)
 * @access  Doctors, TAs, Students (enrolled), College Admins
 * @note    Students cannot see isCorrect or modelAnswer fields
 */
router.get(
    "/:id",
    protect,
    restrictTo("doctor", "ta", "student", "collegeAdmin"),
    attachCollegeScope,
    assessmentController.getAssessment,
);

/**
 * @route   PATCH /api/v1/course-offerings/:offeringId/assessments/:id
 * @desc    Update an assessment (questions, settings, metadata)
 * @access  Doctors & TAs (must be assigned to course)
 * @body    { title?, description?, dueDate?, timeLimitMinutes?, questions?, settings? }
 * @warning MUST use findById → mutate → save() pattern (not findByIdAndUpdate)
 * @audit   HIGH-3: Pre-save hook requires save() to recalculate totalPoints
 */
router.patch(
    "/:id",
    protect,
    restrictTo("doctor"),
    attachCollegeScope,
    assessmentController.updateAssessment,
);

/**
 * @route   DELETE /api/v1/course-offerings/:offeringId/assessments/:id
 * @desc    Soft-delete an assessment (set isArchived = true)
 * @access  Doctors & TAs (must be assigned to course)
 * @note    Archived assessments auto-filtered by pre-find hook
 */
router.delete(
    "/:id",
    protect,
    restrictTo("doctor"),
    attachCollegeScope,
    assessmentController.deleteAssessment,
);

// ===========================================
// STUDENT ROUTES (Assessment Taking Workflow)
// ===========================================

/**
 * @route   GET /api/v1/course-offerings/:offeringId/assessments/:id/start
 * @desc    Start an assessment (creates submission with startedAt timestamp)
 * @access  Students (enrolled in course)
 * @returns Shuffled questions/options (if enabled), submission ID, timer deadline
 * @audit   D-4: Sets startedAt on first access for timer enforcement
 */
router.get(
    "/:id/start",
    protect,
    restrictTo("student"),
    attachCollegeScope,
    assessmentController.startAssessment,
);

export default router;
