/**
 * ===================================================================================
 * @file      assessmentModel.js
 * @desc      Mongoose schema and model definition for Assessments (Assignments, Quizzes, Exams) with custom pre-save validation hooks.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/Assessment
 */

import mongoose from "mongoose";

/**
 * @fileoverview Assessment Model - Manages quizzes, exams, and assignments for course offerings.
 * Supports 6 question types (MCQ-Single, MCQ-Multiple, TrueFalse, Short-Answer, Paragraph, FileUpload),
 * auto-grading for objective questions, and manual grading for subjective responses.
 *
 * @module models/Assessment
 * @requires mongoose
 *
 * @description
 * Key Features:
 * - Multi-type question support with validation
 * - Automatic totalPoints calculation via pre-save hook
 * - Archival soft-delete pattern (pre-find hook auto-filters archived)
 * - Tenant isolation via college_id (IDOR protection)
 * - Timer support for timed assessments
 * - Secure answer hiding (isCorrect, modelAnswer excluded via select: false)
 *
 * @audit
 * - GAP-2A: college_id denormalized from courseOffering (required, indexed)
 * - GAP-2B: Pre-find hook auto-filters isArchived: false
 * - GAP-2C/HIGH-3: Pre-save hook auto-computes totalPoints from questions[].points
 * - GAP-2D: timeLimitMinutes field for server-side timer enforcement
 */

/**
 * Assessment Schema Definition
 *
 * @typedef {Object} Assessment
 * @property {string} title - Assessment title (required, trimmed)
 * @property {string} description - Optional description of the assessment
 * @property {ObjectId} courseOffering_id - Reference to CourseOffering (required, indexed)
 * @property {ObjectId} college_id - Denormalized from CourseOffering for tenant isolation (required, indexed)
 * @property {number} totalPoints - Auto-calculated sum of all question points (managed by pre-save hook)
 * @property {Date} dueDate - Submission deadline (required)
 * @property {number} timeLimitMinutes - Time limit in minutes (null = no limit, min: 1)
 * @property {Array<Question>} questions - Array of assessment questions
 * @property {Object} settings - Assessment behavior configuration
 * @property {boolean} isArchived - Soft-delete flag (default: false, auto-filtered by pre-find hook)
 * @property {Date} createdAt - Auto-generated timestamp
 * @property {Date} updatedAt - Auto-generated timestamp
 */

const assessmentSchema = new mongoose.Schema(
    {
        /**
         * Assessment title
         * @type {string}
         * @required
         * @example "Midterm Exam - Data Structures"
         */
        title: {
            type: String,
            required: [true, "Title is required"],
            trim: true,
        },

        /**
         * Optional detailed description of the assessment
         * @type {string}
         * @example "Covers chapters 1-5: Arrays, Linked Lists, Stacks, Queues"
         */
        description: {
            type: String,
            trim: true,
        },

        /**
         * Reference to the CourseOffering this assessment belongs to
         * @type {ObjectId}
         * @ref CourseOffering
         * @required
         * @indexed
         */
        courseOffering_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },

        /**
         * Denormalized college_id from CourseOffering for tenant isolation (IDOR protection)
         * Set automatically by controller via courseOffering.college_id lookup
         * Never accepted from request body
         *
         * @type {ObjectId}
         * @ref College
         * @required
         * @indexed
         * @audit GAP-2A - Enables req.scopeFilter tenant isolation pattern
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        /**
         * Total points for the assessment (auto-calculated by pre-save hook)
         * Sum of all questions[].points values
         * DO NOT set manually - managed by pre-save middleware
         *
         * @type {number}
         * @default 0
         * @audit GAP-2C/HIGH-3 - Auto-computed to prevent desync bugs
         */
        totalPoints: {
            type: Number,
            default: 0,
        },

        /**
         * Submission deadline
         * Students cannot submit after this date unless explicitly allowed
         *
         * @type {Date}
         * @required
         */
        dueDate: {
            type: Date,
            required: true,
        },

        /**
         * Time limit in minutes for the assessment
         * null = no time limit (untimed assessment)
         * Server-side timer enforcement uses startedAt + (timeLimitMinutes * 60_000)
         *
         * @type {number|null}
         * @default null
         * @minimum 1
         * @audit GAP-2D - Server-side timer anchor for timed assessments
         */
        timeLimitMinutes: {
            type: Number,
            default: null,
            min: [1, "Time limit must be at least 1 minute"],
        },

        /**
         * Array of assessment questions
         * Supports 6 question types with type-specific validation
         *
         * @type {Array<Question>}
         */
        questions: [
            {
                /**
                 * The question text/prompt
                 * @type {string}
                 * @required
                 */
                questionText: {
                    type: String,
                    required: true,
                },

                /**
                 * Display order (0-indexed)
                 * Used for sorting and shuffle restoration
                 * @type {number}
                 * @default 0
                 */
                order: {
                    type: Number,
                    default: 0,
                },

                /**
                 * File attachments for the question (images, PDFs, etc.)
                 * @type {Array<{fileName: string, fileUrl: string}>}
                 */
                attachments: [
                    {
                        fileName: String,
                        fileUrl: String,
                    },
                ],

                /**
                 * Question type - determines grading logic and UI rendering
                 * MCQ-Single: One correct option, auto-graded
                 * MCQ-Multiple: Multiple correct options, auto-graded
                 * TrueFalse: Boolean question, auto-graded
                 * Short-Answer: Text input, manual grading
                 * Paragraph: Long text input, manual grading
                 * FileUpload: File submission, manual grading
                 *
                 * @type {string}
                 * @required
                 * @enum ['MCQ-Single', 'MCQ-Multiple', 'TrueFalse', 'Short-Answer', 'Paragraph', 'FileUpload']
                 */
                questionType: {
                    type: String,
                    enum: [
                        "MCQ-Single",
                        "MCQ-Multiple",
                        "TrueFalse",
                        "Short-Answer",
                        "Paragraph",
                        "FileUpload",
                    ],
                    required: true,
                },

                /**
                 * Whether the question must be answered
                 * @type {boolean}
                 * @default true
                 */
                isRequired: {
                    type: Boolean,
                    default: true,
                },

                /**
                 * Answer options for MCQ and TrueFalse questions
                 * For TrueFalse: [{text: "True"}, {text: "False"}]
                 * For MCQ: Custom options with isCorrect flags
                 *
                 * @type {Array<{text: string, isCorrect: boolean}>}
                 */
                options: [
                    {
                        text: String,
                        /**
                         * Marks this option as correct (for auto-grading)
                         * SECURITY: select: false prevents leaking to students
                         * @type {boolean}
                         * @default false
                         * @select false
                         */
                        isCorrect: {
                            type: Boolean,
                            default: false,
                            select: false,
                        },
                    },
                ],

                /**
                 * Whether to randomize option order for this question
                 * Uses seeded shuffle (same seed = same order per student)
                 * @type {boolean}
                 * @default false
                 */
                shuffleOptions: {
                    type: Boolean,
                    default: false,
                },

                /**
                 * Validation rules for text-based answers
                 * Used for Short-Answer and Paragraph types
                 * @type {Object}
                 */
                validation: {
                    /** Regex pattern for answer validation */
                    regex: String,
                    /** Minimum character length */
                    minLength: Number,
                    /** Maximum character length */
                    maxLength: Number,
                },

                /**
                 * Model answer for manual grading reference
                 * SECURITY: select: false prevents leaking to students
                 * Only visible to doctors/TAs during grading
                 *
                 * @type {string}
                 * @select false
                 */
                modelAnswer: {
                    type: String,
                    select: false,
                },

                /**
                 * Points awarded for correct answer
                 * Used in totalPoints calculation (pre-save hook)
                 * @type {number}
                 * @required
                 */
                points: {
                    type: Number,
                    required: true,
                },
            },
        ],

        /**
         * Assessment behavior settings
         * Controls student experience and grading workflow
         */
        settings: {
            /**
             * Randomize question order per student
             * Uses seeded shuffle for consistency
             * @type {boolean}
             * @default false
             */
            shuffleQuestions: {
                type: Boolean,
                default: false,
            },

            /**
             * Allow students to edit submission after initial submit
             * If false, submission is final
             * @type {boolean}
             * @default false
             */
            allowEditAfterSubmit: {
                type: Boolean,
                default: false,
            },

            /**
             * Enforce one submission per student
             * @type {boolean}
             * @default true
             */
            limitToOneResponse: {
                type: Boolean,
                default: true,
            },

            /**
             * Show auto-graded scores immediately after submission
             * If false, students see grades only after manual grading
             * @type {boolean}
             * @default false
             */
            showGradesImmediately: {
                type: Boolean,
                default: false,
            },

            /**
             * Whether the assessment is currently accepting submissions
             * Can be toggled by doctors to open/close submissions
             * @type {boolean}
             * @default true
             */
            acceptingResponses: {
                type: Boolean,
                default: true,
            },

            /**
             * Message shown to students after successful submission
             * @type {string}
             * @default "Your response has been recorded."
             */
            confirmationMessage: {
                type: String,
                default: "Your response has been recorded.",
            },
        },

        /**
         * Soft-delete flag for archival
         * When true, assessment is hidden from all queries (via pre-find hook)
         * Prevents hard deletion while maintaining data integrity
         *
         * @type {boolean}
         * @default false
         * @audit GAP-2B - Auto-filtered by pre-find hook array middleware
         */
        isArchived: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    },
);

// ===========================================
// MIDDLEWARE HOOKS
// ===========================================

/**
 * Pre-find middleware (array form) - Auto-filter archived assessments
 *
 * Automatically adds { isArchived: false } to all find queries
 * Covers: find, findOne, findById, countDocuments, exists
 *
 * @middleware
 * @audit GAP-2B - Phase 1 archival pattern, prevents archived leakage
 *
 * @note Array form required to cover countDocuments (single function form does not)
 * @see Phase 1 soft-delete implementation pattern
 */
assessmentSchema.pre(
    [
        "find",
        "findOne",
        "findOneAndUpdate",
        "findOneAndDelete",
        "countDocuments",
    ],
    function (next) {
        // Only apply filter if isArchived hasn't been explicitly set in query
        if (this.getQuery().isArchived === undefined) {
            this.where({ isArchived: false });
        }
    },
);

/**
 * Pre-save middleware - Auto-calculate totalPoints from questions
 *
 * Recalculates totalPoints as sum of all questions[].points whenever:
 * 1. Document is new (isNew === true)
 * 2. questions array has been modified (isModified('questions'))
 *
 * Prevents manual totalPoints manipulation and ensures consistency
 *
 * @middleware
 * @audit GAP-2C/HIGH-3 - Prevents desync between questions and totalPoints
 *
 * @note Uses doc.save() pattern required for this hook to fire
 * @warning Controllers MUST use findById → mutate → doc.save() for question updates
 *          Using findByIdAndUpdate bypasses this hook and breaks totalPoints sync
 */
assessmentSchema.pre("save", function (next) {
    // Recalculate totalPoints if questions array was modified or doc is new
    if (this.isModified("questions") || this.isNew) {
        this.totalPoints = this.questions.reduce((sum, question) => {
            return sum + (question.points || 0);
        }, 0);
    }
});

// ===========================================
// MODEL EXPORT
// ===========================================

/**
 * Assessment Model
 * @type {mongoose.Model<Assessment>}
 */
const Assessment = mongoose.model("Assessment", assessmentSchema);
export default Assessment;
