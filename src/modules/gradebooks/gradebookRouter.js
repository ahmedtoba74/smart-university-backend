/**
 * ===================================================================================
 * @file      gradebookRouter.js
 * @desc      Router for gradebook management endpoints (semester work, GPA calculation).
 *            Base path: /api/v1/gradebook
 * @module    modules/gradebook/gradebookRouter
 * @requires  express, authMiddleware, gradebookController
 * ===================================================================================
 */

import express from "express";
import {
    protect,
    restrictTo,
    attachCollegeScope,
    attachStaffScope,
} from "../../middlewares/authMiddleware.js";
import * as gradebookController from "./gradebookController.js";

/**
 * Gradebook Router
 *
 * Base path: /api/v1/gradebook
 * Handles semester work entry, gradebook publishing, and GPA management
 *
 * Middleware Stack:
 * 1. protect - JWT authentication
 * 2. restrictTo - Role-based access control
 */
const router = express.Router();

// ===========================================
// GRADEBOOK RETRIEVAL ROUTES
// ===========================================

/**
 * @route   GET /api/v1/gradebook/course/:offeringId
 * @desc    Get full gradebook for a course offering (all enrolled students)
 * @access  Doctors, TAs, College Admins
 * @returns Array of enrollments with student details and grade components
 * @note    Excludes withdrawn students (status != 'withdrawn')
 */
router.get(
    "/course/:offeringId",
    protect,
    restrictTo("doctor", "ta", "collegeAdmin"),
    attachCollegeScope,
    attachStaffScope,
    gradebookController.getCourseGradebook,
);

/**
 * @route   GET /api/v1/gradebook/student/:studentId
 * @desc    Get a student's gradebook across all enrolled courses
 * @access  Students (self only), Doctors, College Admins
 * @returns Array of enrollments with course details and grades
 * @note    Students can only access their own gradebook
 */
router.get(
    "/student/:studentId",
    protect,
    restrictTo("student", "doctor", "collegeAdmin"),
    attachCollegeScope,
    gradebookController.getStudentGradebook,
);

// ===========================================
// SEMESTER WORK ENTRY ROUTES (Doctors Only)
// ===========================================

/**
 * @route   PATCH /api/v1/gradebook/course/:offeringId/semester-work
 * @desc    Bulk update semester work grades (attendance, midterm, project)
 * @access  Doctors (assigned to course)
 * @body    { grades: [{ studentId, attendance?, midterm?, project? }] }
 * @note    Blocked if semesterWorkLocked = true
 * @audit   D-20: Validates each student is enrolled, updates assignments via recalc
 */
router.patch(
    "/course/:offeringId/semester-work",
    protect,
    restrictTo("doctor"),
    attachCollegeScope,
    attachStaffScope,
    gradebookController.updateSemesterWork,
);

/**
 * @route   POST /api/v1/gradebook/course/:offeringId/lock-semester-work
 * @desc    Lock semester work (set semesterWorkLocked = true)
 * @access  Doctors (assigned to course)
 * @note    Irreversible unless resultsPublished = false
 * @audit   State transition: enables finalExam entry, prevents semester work edits
 */
router.post(
    "/course/:offeringId/lock-semester-work",
    protect,
    restrictTo("doctor", "collegeAdmin", "universityAdmin"),
    attachCollegeScope,
    attachStaffScope,
    gradebookController.lockSemesterWork,
);

/**
 * @route   POST /api/v1/gradebook/course/:offeringId/unlock-semester-work
 * @desc    Unlock semester work (set semesterWorkLocked = false)
 * @access  Doctors (assigned to course)
 * @note    Only allowed if resultsPublished = false
 * @audit   Rollback mechanism for semester work corrections
 */
router.post(
    "/course/:offeringId/unlock-semester-work",
    protect,
    restrictTo("universityAdmin", "collegeAdmin", "doctor"),
    attachCollegeScope,
    gradebookController.unlockSemesterWork,
);

// ===========================================
// STUDENT SELF-VIEW ROUTES
// ===========================================

/**
 * @route   GET /api/v1/gradebook/course/:offeringId/my
 * @desc    Get authenticated student's own grades for a course offering
 * @access  Students (enrolled in offering)
 * @returns Enrollment with grade components (finalTotal/finalLetter stripped if not published)
 * @audit   CRIT-10: Missing endpoint from Plan Section 17
 */
router.get(
    "/course/:offeringId/my",
    protect,
    restrictTo("student"),
    gradebookController.getMyGrades,
);

// ===========================================
// FINAL EXAM ENTRY ROUTES (College Admins)
// ===========================================

/**
 * @route   PATCH /api/v1/gradebook/course/:offeringId/final-exam
 * @desc    Bulk update final exam grades
 * @access  College Admins
 * @body    { grades: [{ studentId, finalExam }] }
 * @note    Requires semesterWorkLocked = true
 * @note    Blocked if resultsPublished = true
 */
router.patch(
    "/course/:offeringId/final-exam",
    protect,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    gradebookController.updateFinalExam,
);

// ===========================================
// GRADEBOOK PUBLISH ROUTE (College Admins)
// ===========================================

/**
 * @route   POST /api/v1/gradebook/course/:offeringId/publish
 * @desc    Publish gradebook results (calculate final grades, update GPA, set resultsPublished)
 * @access  College Admins
 * @note    Requires semesterWorkLocked = true
 * @audit   D-25: Do not call concurrently for overlapping student sets
 *          D-26: Fetches ALL enrollments (no college_id filter) for cumulative GPA
 * @workflow
 *   1. Validate semesterWorkLocked = true
 *   2. For each enrollment:
 *      a. Calculate finalTotal using gradingPolicy weights
 *      b. Map finalTotal to letter grade (mapScoreToLetter)
 *      c. Update enrollment status (passed/failed)
 *      d. Recalculate student GPA across ALL enrollments
 *      e. Update earnedCredits (add creditHours if passed)
 *      f. Update level based on earnedCredits (levelThresholds)
 *      g. Update academicStatus (probation if GPA < 2.0)
 *   3. Set resultsPublished = true
 */
router.post(
    "/course/:offeringId/publish",
    protect,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    gradebookController.publishGradebook,
);

// ===========================================
// ADMIN RECOVERY TOOLS (University Admin)
// ===========================================

/**
 * @route   POST /api/v1/gradebook/admin/students/:studentId/rebuild-gpa
 * @desc    Rebuild a student's GPA from scratch (recovery tool for D-25)
 * @access  University Admin only
 * @audit   D-25: Designated recovery tool for concurrent publish race condition
 *          D-26: No college_id filter for cumulative GPA
 */
router.post(
    "/admin/students/:studentId/rebuild-gpa",
    protect,
    restrictTo("universityAdmin"),
    gradebookController.rebuildStudentGpa,
);

export default router;
