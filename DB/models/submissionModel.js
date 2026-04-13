import mongoose from "mongoose";

/**
 * @fileoverview Submission Model - Manages student responses to assessments.
 * Tracks submission lifecycle (in_progress → submitted → graded), stores answers,
 * handles auto-grading for objective questions, and supports manual grading workflow.
 *
 * @module models/Submission
 * @requires mongoose
 *
 * @description
 * Key Features:
 * - One submission per student per assessment (unique index enforced)
 * - State machine: in_progress → submitted → graded
 * - Timer support via startedAt anchor (for timed assessments)
 * - Denormalized courseOffering_id for efficient gradebook aggregations
 * - Tenant isolation via college_id (IDOR protection)
 * - Multi-format answer storage (text, single option, multiple options, file)
 * - Per-question scoring and feedback
 *
 * @audit
 * - GAP-1: courseOffering_id denormalized for single-query aggregations
 * - GAP-1: college_id for tenant isolation (req.scopeFilter pattern)
 * - GAP-1: startedAt for server-side timer enforcement
 * - MED-1: Compound index { student_id, courseOffering_id, status } for covered queries
 */

/**
 * Submission Schema Definition
 *
 * @typedef {Object} Submission
 * @property {ObjectId} assessment_id - Reference to Assessment (required)
 * @property {ObjectId} student_id - Reference to User (student) (required)
 * @property {ObjectId} courseOffering_id - Denormalized from Assessment for aggregation efficiency (required)
 * @property {ObjectId} college_id - Denormalized for tenant isolation (required)
 * @property {string} status - Submission lifecycle state (in_progress|submitted|graded)
 * @property {Date} startedAt - Timer anchor (set on first GET /start, null on ghost force-submissions)
 * @property {Date} submittedAt - Timestamp when student clicked submit
 * @property {number} totalScore - Auto-calculated sum of all answer scores
 * @property {ObjectId} gradedBy_id - Reference to doctor/TA who graded (manual grading only)
 * @property {Array<Answer>} answers - Student's answers to assessment questions
 * @property {Date} createdAt - Auto-generated timestamp
 * @property {Date} updatedAt - Auto-generated timestamp
 */

const submissionSchema = new mongoose.Schema(
    {
        /**
         * Reference to the Assessment being submitted
         * @type {ObjectId}
         * @ref Assessment
         * @required
         */
        assessment_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Assessment",
            required: [true, "Assessment ID is required"],
        },

        /**
         * Reference to the Student (User) making the submission
         * @type {ObjectId}
         * @ref User
         * @required
         */
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
        },

        /**
         * Denormalized courseOffering_id from Assessment
         * Enables single-query gradebook aggregations without joining through Assessment
         * Set automatically by controller via assessment.courseOffering_id lookup
         * Never accepted from request body
         *
         * @type {ObjectId}
         * @ref CourseOffering
         * @required
         * @indexed
         * @audit GAP-1 - Eliminates join in recalculateAssignmentGrade aggregation
         */
        courseOffering_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },

        /**
         * Denormalized college_id for tenant isolation (IDOR protection)
         * Denormalized from Assessment → CourseOffering chain
         * Enables req.scopeFilter tenant isolation pattern from Phase 3
         * Set automatically by controller, never from request body
         *
         * @type {ObjectId}
         * @ref College
         * @required
         * @indexed
         * @audit GAP-1 - Tenant isolation (student_id alone is insufficient, see Decision D-15)
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        /**
         * Submission lifecycle state
         * State machine flow: in_progress → submitted → graded
         *
         * in_progress: Student is actively working (can save draft answers)
         * submitted: Student has finalized submission (no further edits unless allowEditAfterSubmit)
         * graded: All answers have been scored (manual or auto)
         *
         * @type {string}
         * @enum ['in_progress', 'submitted', 'graded']
         * @default 'in_progress'
         */
        status: {
            type: String,
            enum: ["in_progress", "submitted", "graded"],
            default: "in_progress",
        },

        /**
         * Timer anchor for timed assessments
         * Set on first GET /assessments/:id/start (when student begins)
         * null for ghost force-submissions (timer expired, auto-submitted with saved answers)
         *
         * Server-side timer deadline calculation:
         * deadline = startedAt + (assessment.timeLimitMinutes * 60_000)
         *
         * @type {Date|null}
         * @default null
         * @audit GAP-1/D-4 - Server-side timer enforcement anchor
         *
         * @note null on ghost submissions is expected and documented behavior
         * @see Decision D-4 for timer expiry handling logic
         */
        startedAt: {
            type: Date,
            default: null,
        },

        /**
         * Timestamp when student clicked "Submit" button
         * Set when status transitions from in_progress → submitted
         * Used for late submission detection (compared against assessment.dueDate)
         *
         * @type {Date}
         */
        submittedAt: {
            type: Date,
        },

        /**
         * Total score across all answers
         * Auto-calculated as sum of answers[].score
         * Updated after auto-grading or manual grading
         *
         * @type {number}
         * @default 0
         */
        totalScore: {
            type: Number,
            default: 0,
        },

        /**
         * Reference to the User (doctor/TA) who performed manual grading
         * Only populated for submissions with manually-graded questions
         * Auto-graded submissions leave this null
         *
         * @type {ObjectId}
         * @ref User
         */
        gradedBy_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },

        /**
         * Array of student's answers to assessment questions
         * One answer object per question in the assessment
         * Format varies by question type (text, single option, multiple options, file)
         *
         * @type {Array<Answer>}
         */
        answers: [
            {
                /**
                 * Reference to the question being answered (from Assessment.questions[])
                 * @type {ObjectId}
                 * @required
                 */
                questionId: {
                    type: mongoose.Schema.Types.ObjectId,
                    required: true,
                },

                /**
                 * Text-based answer for Short-Answer and Paragraph questions
                 * Also stores boolean ("true"/"false") for TrueFalse questions
                 * @type {string}
                 */
                answerText: String,

                /**
                 * Selected option ID for MCQ-Single questions
                 * References Assessment.questions[].options[]._id
                 * @type {ObjectId}
                 */
                selectedOptionId: mongoose.Schema.Types.ObjectId,

                /**
                 * Array of selected option IDs for MCQ-Multiple questions
                 * References Assessment.questions[].options[]._id
                 * @type {Array<ObjectId>}
                 */
                selectedOptionIds: [
                    {
                        type: mongoose.Schema.Types.ObjectId,
                    },
                ],

                /**
                 * Uploaded file URL for FileUpload questions
                 * Points to Cloudinary or cloud storage location
                 * @type {string}
                 */
                fileUrl: String,

                /**
                 * Points earned for this answer
                 * Auto-graded for MCQ/TrueFalse (compared against isCorrect flags)
                 * Manually set by doctors/TAs for Short-Answer/Paragraph/FileUpload
                 *
                 * @type {number}
                 * @default 0
                 */
                score: {
                    type: Number,
                    default: 0,
                },

                /**
                 * Textual feedback from grader
                 * Optional, typically used for manual grading to explain scoring
                 * @type {string}
                 */
                feedback: {
                    type: String,
                },
            },
        ],
    },
    {
        timestamps: true,
    },
);

// ===========================================
// INDEXES
// ===========================================

/**
 * Unique index - Enforce one submission per student per assessment
 * Prevents duplicate submissions for the same assessment
 *
 * @index {assessment_id, student_id} unique
 */
submissionSchema.index({ assessment_id: 1, student_id: 1 }, { unique: true });

/**
 * Compound index - Gradebook aggregation optimization
 * Covers the $match stage in recalculateAssignmentGrade aggregation:
 * Submission.aggregate([
 *   { $match: { student_id, courseOffering_id, status: 'graded' } },
 *   ...
 * ])
 *
 * Makes this a covered query (no document fetch needed)
 * Critical for performance when recalculating assignment grades for full class
 *
 * @index {student_id, courseOffering_id, status}
 * @audit MED-1 - Performance optimization for gradebook recalculation hot path
 */
submissionSchema.index({
    student_id: 1,
    courseOffering_id: 1,
    status: 1,
});

// ===========================================
// MODEL EXPORT
// ===========================================

/**
 * Submission Model
 * @type {mongoose.Model<Submission>}
 */
const Submission = mongoose.model("Submission", submissionSchema);
export default Submission;
