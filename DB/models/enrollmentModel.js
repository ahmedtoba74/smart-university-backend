/**
 * ===================================================================================
 * @file      enrollmentModel.js
 * @desc      Mongoose schema and model definition for Enrollments, managing student registrations, grades, and GPA calculations.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/Enrollment
 */

import mongoose from "mongoose";

/**
 * @fileoverview Enrollment Model - Manages student course enrollments and academic records.
 * Tracks enrollment lifecycle, grades, attendance, and supports retakes/re-enrollment.
 * Central to gradebook calculations and prerequisite validation.
 *
 * @module models/Enrollment
 * @requires mongoose
 *
 * @description
 * Key Features:
 * - State machine: enrolled → passed|failed|withdrawn
 * - Retake & re-enrollment support via partial unique index
 * - Grade snapshotting for historical integrity
 * - Force enrollment audit trail (Gate bypass tracking)
 * - Optimized indexes for prerequisite checks and credit limits
 * - Tenant isolation via college_id
 *
 * @audit
 * - GAP-4: Additional compound index { course_id, status } for full-class gradebook queries
 * - Phase 3: Partial unique index for retake/re-enrollment support
 * - Phase 3: Prerequisite optimization index { student_id, catalogCourse_id, status }
 * - Phase 3: Credit limit hot-path index { student_id, semester, academicYear, status }
 */

/**
 * Enrollment Schema Definition
 *
 * @typedef {Object} Enrollment
 * @property {ObjectId} student_id - Reference to User (student) (required, indexed)
 * @property {ObjectId} course_id - Reference to CourseOffering (required, indexed)
 * @property {ObjectId} catalogCourse_id - Reference to CourseCatalog for retake/prereq logic (required, indexed)
 * @property {ObjectId} college_id - For tenant isolation and IDOR scoping (required, indexed)
 * @property {string} semester - Semester of enrollment (First|Second|Summer) (required, indexed)
 * @property {string} academicYear - Academic year (e.g., "2025-2026") (required, indexed)
 * @property {string} status - Enrollment lifecycle state (enrolled|passed|failed|withdrawn)
 * @property {number} finalAttendancePercentage - Final attendance percentage (0-100)
 * @property {Object} grades - Grade components sub-document
 * @property {Object} snapshot - Historical snapshot of course data
 * @property {Object} forceEnrolled - Audit trail for admin override enrollments
 * @property {Date} createdAt - Auto-generated timestamp
 * @property {Date} updatedAt - Auto-generated timestamp
 */

const enrollmentSchema = new mongoose.Schema(
    {
        /**
         * Reference to the Student (User) enrolled in the course
         * Used for all student-scoped queries
         *
         * @type {ObjectId}
         * @ref User
         * @required
         * @indexed
         */
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
            index: true,
        },

        /**
         * Reference to the CourseOffering (semester instance)
         * Links to specific course offering with doctors, TAs, schedule
         *
         * @type {ObjectId}
         * @ref CourseOffering
         * @required
         * @indexed
         */
        course_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },

        /**
         * Reference to CourseCatalog (course definition)
         * Required for:
         * 1. Partial unique index to support retakes and re-enrollment
         * 2. Optimized Gate 3 prerequisite query (find passed courses)
         *
         * @type {ObjectId}
         * @ref CourseCatalog
         * @required
         * @indexed
         *
         * @note Denormalized from course_id.catalogCourse_id for performance
         * @see Partial unique index below for retake logic
         */
        catalogCourse_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseCatalog",
            required: [true, "Catalog Course ID is required"],
            index: true,
        },

        /**
         * College ID for fast IDOR scoping
         * Enables req.scopeFilter to apply explicitly without joining CourseOffering
         * Allows college admins to query enrollments natively
         *
         * @type {ObjectId}
         * @ref College
         * @required
         * @indexed
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        /**
         * Semester of enrollment
         * Combined with academicYear to identify enrollment term
         *
         * @type {string}
         * @required
         * @indexed
         * @enum ['First', 'Second', 'Summer']
         */
        semester: {
            type: String,
            required: [true, "Semester is required"],
            index: true,
        },

        /**
         * Academic year of enrollment (e.g., "2025-2026")
         * Needed for credit-limit aggregation and term filtering
         * Combined with semester for unique term identification
         *
         * @type {string}
         * @required
         * @indexed
         */
        academicYear: {
            type: String,
            required: [true, "Academic Year is required"],
            index: true,
        },

        /**
         * Enrollment lifecycle state
         * State machine flow:
         * - enrolled: Active enrollment, semester in progress
         * - passed: Course completed successfully (grade >= D)
         * - failed: Course completed unsuccessfully (grade = F)
         * - withdrawn: Student dropped the course
         *
         * @type {string}
         * @enum ['enrolled', 'passed', 'failed', 'withdrawn']
         * @default 'enrolled'
         *
         * @note Status transitions handled by gradebook publish workflow
         * @note 'withdrawn' excluded from partial unique index (allows re-enrollment)
         */
        status: {
            type: String,
            enum: ["enrolled", "passed", "failed", "withdrawn"],
            default: "enrolled",
        },

        /**
         * Final attendance percentage (0-100)
         * Updated throughout semester, frozen at course completion
         * Used in final grade calculation via gradingPolicy.weights.attendance
         *
         * @type {number}
         * @default 0
         * @minimum 0
         * @maximum 100
         */
        finalAttendancePercentage: {
            type: Number,
            default: 0,
        },

        /**
         * Grade components sub-document
         * All components normalized to 0-100 scale
         * Final weighted score calculated via gradingPolicy
         */
        grades: {
            /**
             * Attendance grade component (0-100)
             * Derived from finalAttendancePercentage
             * @type {number}
             * @default 0
             */
            attendance: {
                type: Number,
                default: 0,
            },

            /**
             * Midterm exam grade (0-100)
             * Manually entered by doctors, locked after semesterWorkLocked
             * @type {number}
             * @default 0
             */
            midterm: {
                type: Number,
                default: 0,
            },

            /**
             * Assignments grade component (0-100)
             * Auto-calculated by recalculateAssignmentGrade aggregation
             * Sum of graded submissions / total possible points
             * @type {number}
             * @default 0
             */
            assignments: {
                type: Number,
                default: 0,
            },

            /**
             * Project grade component (0-100)
             * Manually entered by doctors, locked after semesterWorkLocked
             * @type {number}
             * @default 0
             */
            project: {
                type: Number,
                default: 0,
            },

            /**
             * Final exam grade (0-100)
             * Manually entered by doctors/college admins
             * Can only be entered after semesterWorkLocked = true
             * @type {number}
             * @default 0
             */
            finalExam: {
                type: Number,
                default: 0,
            },

            /**
             * Final total grade (0-100)
             * Weighted sum of all components using gradingPolicy.weights
             * Calculated during gradebook publish workflow
             * @type {number}
             * @default 0
             */
            finalTotal: {
                type: Number,
                default: 0,
            },

            /**
             * Final letter grade (A+, A, B+, ..., F)
             * Mapped from finalTotal using Settings.gradeThresholds
             * Set during gradebook publish workflow
             * @type {string|null}
             * @default null
             */
            finalLetter: {
                type: String,
                default: null,
            },
        },

        /**
         * Snapshot of critical course data for historical integrity
         * Frozen at enrollment creation to preserve record even if catalog changes
         * Used for transcripts and audit trails
         */
        snapshot: {
            /**
             * Course code at time of enrollment
             * @type {string}
             * @example "CS101"
             */
            courseCode: String,

            /**
             * Course title at time of enrollment
             * @type {string}
             * @example "Introduction to Programming"
             */
            courseTitle: String,

            /**
             * Credit hours at time of enrollment
             * @type {number}
             * @example 3
             */
            creditHours: Number,
        },

        /**
         * Audit trail for admin override enrollments
         * Only populated when POST /enrollments/force is used
         * Documents which enrollment gates were bypassed
         */
        forceEnrolled: {
            /**
             * Reference to admin/doctor who forced the enrollment
             * @type {ObjectId}
             * @ref User
             */
            forcedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },

            /**
             * Timestamp of forced enrollment
             * @type {Date}
             */
            forcedAt: Date,

            /**
             * List of gates that were bypassed
             * @type {Array<string>}
             * @example ["Gate 1: Enrollment Period", "Gate 2: Credit Limit"]
             */
            gatesBypassed: [String],

            /**
             * Whether capacity limit was overridden
             * @type {boolean}
             */
            overrideCapacity: Boolean,

            /**
             * Whether credit limit was overridden
             * @type {boolean}
             */
            overrideCreditLimit: Boolean,
        },
    },
    { timestamps: true },
);

// ===========================================
// INDEXES
// ===========================================

/**
 * 1. Partial Unique Index — Retake & Re-enrollment Support
 *
 * Replaces old { student_id, course_id } unique constraint.
 *
 * Allows:
 * - Retakes across semesters (different academicYear/semester)
 * - Re-enrollment after withdrawal in SAME semester
 *   (because 'withdrawn' status is excluded from the partial match)
 *
 * Prevents:
 * - Double-enrollment in the same catalog course while active
 *   (same student + same catalogCourse_id + same term + status in [enrolled, passed, failed])
 *
 * @index {student_id, catalogCourse_id, semester, academicYear} unique (partial)
 * @partialFilterExpression status in ['enrolled', 'passed', 'failed']
 *
 * @audit Phase 3 - Retake/re-enrollment support
 */
enrollmentSchema.index(
    {
        student_id: 1,
        catalogCourse_id: 1,
        semester: 1,
        academicYear: 1,
    },
    {
        unique: true,
        partialFilterExpression: {
            status: { $in: ["enrolled", "passed", "failed"] },
        },
    },
);

/**
 * 2. Gate 3 Prerequisite Optimization Index
 *
 * Supports prerequisite validation query:
 * Enrollment.find({
 *   student_id,
 *   catalogCourse_id: { $in: prerequisiteIds },
 *   status: 'passed'
 * })
 *
 * Covers the query for checking if student has passed all prerequisites
 * Critical for enrollment gate performance
 *
 * @index {student_id, catalogCourse_id, status}
 * @audit Phase 3 - Gate 3 prerequisite check optimization
 */
enrollmentSchema.index({
    student_id: 1,
    catalogCourse_id: 1,
    status: 1,
});

/**
 * 3. Gate 2 Credit Limit Hot-Path Index
 *
 * Covers the $match stage of credit limit aggregation pipeline:
 * Enrollment.aggregate([
 *   { $match: { student_id, semester, academicYear, status: { $ne: 'withdrawn' } } },
 *   ...
 * ])
 *
 * Used inside enrollment creation transaction for real-time credit limit validation
 *
 * @index {student_id, semester, academicYear, status}
 * @audit Phase 3 - Gate 2 credit limit check optimization
 */
enrollmentSchema.index({
    student_id: 1,
    semester: 1,
    academicYear: 1,
    status: 1,
});

/**
 * 4. Full-Class Gradebook Query Optimization Index
 *
 * Supports full-class gradebook retrieval:
 * Enrollment.find({
 *   course_id: offeringId,
 *   status: { $ne: 'withdrawn' }
 * })
 *
 * Used by:
 * - GET /gradebook/course/:offeringId (display all students in course)
 * - POST /gradebook/course/:offeringId/publish (gradebook publish workflow)
 * - Bulk grade entry operations
 *
 * @index {course_id, status}
 * @audit GAP-4 - Performance optimization for full-class gradebook queries
 */
enrollmentSchema.index({
    course_id: 1,
    status: 1,
});

// ===========================================
// MODEL EXPORT
// ===========================================

/**
 * Enrollment Model
 * @type {mongoose.Model<Enrollment>}
 */
const Enrollment = mongoose.model("Enrollment", enrollmentSchema);
export default Enrollment;
