/**
 * ===================================================================================
 * @file      courseOfferingModel.js
 * @desc      Mongoose schema and model definition for Course Offerings, representing active course instances, schedules, and instructors.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/CourseOffering
 */

import mongoose from "mongoose";

const courseOfferingSchema = new mongoose.Schema(
    {
        course_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseCatalog",
            required: [true, "Course Catalog ID is required"],
        },
        /**
         * @field college_id - Denormalized from course_id -> department -> college for fast scoping.
         * Set automatically by the controller when creating a new offering.
         * Allows a single-query filter: CourseOffering.find({ college_id }) for collegeAdmin.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },
        /**
         * @field department_id - Denormalized from CourseCatalog for department-level filtering
         * and security validation. Never set from request body.
         */
        department_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Department",
            required: [true, "Department ID is required"],
            index: true,
        },
        semester: {
            type: String,
            required: [true, "Semester is required"],
            index: true,
            trim: true,
        },
        /**
         * @field academicYear - Required to distinguish terms across years.
         * Always read from the Settings singleton — never accepted from request body.
         * e.g. "2025-2026"
         */
        academicYear: {
            type: String,
            required: [true, "Academic Year is required"],
            trim: true,
            index: true,
        },
        doctors_ids: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],
        tas_ids: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],
        schedule: [
            {
                day: {
                    type: String,
                    enum: [
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                    ],
                    required: true,
                },
                startTime: {
                    type: String,
                    required: true,
                    validate: {
                        validator: function (v) {
                            return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
                        },
                        message: (props) =>
                            `${props.value} is not a valid time format (HH:MM)!`,
                    },
                },
                endTime: {
                    type: String,
                    required: true,
                    validate: {
                        validator: function (v) {
                            return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
                        },
                        message: (props) =>
                            `${props.value} is not a valid time format (HH:MM)!`,
                    },
                },
                location: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Location",
                    required: true,
                },
                sessionType: {
                    type: String,
                    enum: ["lecture", "lab", "section"],
                    required: true,
                },
            },
        ],
        maxSeats: {
            type: Number,
            default: 50,
        },
        currentEnrolled: {
            type: Number,
            default: 0,
        },
        /**
         * @field totalDegree - Absolute degree total (e.g. 100 or 150).
         * The gradingPolicy components must sum to exactly this value.
         */
        totalDegree: {
            type: Number,
            required: [true, "Total degree is required"],
            min: [1, "Total degree must be at least 1"],
        },
        /**
         * @field gradingPolicy - Flexible component distribution.
         * All components have min: 0, default: 0. Only totalDegree >= 1 is enforced.
         * Allows 100% exam, 100% project, or any custom distribution.
         * The sum of all components must equal totalDegree (validated in pre-save hook).
         */
        gradingPolicy: {
            attendance: { type: Number, min: 0, default: 0 },
            midterm: { type: Number, min: 0, default: 0 },
            assignments: { type: Number, min: 0, default: 0 },
            project: { type: Number, min: 0, default: 0 },
            finalExam: { type: Number, min: 0, default: 0 },
        },
        /**
         * @field semesterWorkLocked - Set to true when doctor clicks "Submit Semester Work".
         * Once locked, no further edits to midterm/assignments/attendance grades are allowed.
         * The finalExam grade (entered by collegeAdmin/Kontrol) is unaffected.
         */
        semesterWorkLocked: {
            type: Boolean,
            default: false,
        },
        /**
         * @field resultsPublished - Set to true by collegeAdmin after GPA calculation is complete.
         * Controls visibility: students cannot see finalTotal or finalLetter until this is true.
         */
        resultsPublished: {
            type: Boolean,
            default: false,
        },
        isArchived: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true },
);

// ===========================================
// INDEXES
// ===========================================

/**
 * Compound unique index: only one offering per catalog course per term.
 * Replaces the old { semester: 1, course_id: 1 } index.
 * Migration note: drop the old index manually if it exists.
 */
courseOfferingSchema.index(
    { academicYear: 1, semester: 1, course_id: 1 },
    { unique: true },
);

// ===========================================
// DOCUMENT MIDDLEWARE — Validation Hooks
// ===========================================

/**
 * Pre-validate hook: Ensure startTime < endTime for each schedule slot.
 */
courseOfferingSchema.pre("validate", function (next) {
    if (this.schedule) {
        for (const session of this.schedule) {
            if (session.startTime >= session.endTime) {
                this.invalidate(
                    "schedule",
                    `Start time (${session.startTime}) must be before End time (${session.endTime})`,
                );
            }
        }
    }
});

/**
 * Pre-save hook (defense-in-depth): Validate gradingPolicy components sum to totalDegree.
 * The controller also performs this check, but this hook catches direct model usage.
 */
courseOfferingSchema.pre("save", function (next) {
    if (this.isModified("totalDegree") || this.isModified("gradingPolicy")) {
        const gp = this.gradingPolicy;
        const sum =
            (gp.attendance || 0) +
            (gp.midterm || 0) +
            (gp.assignments || 0) +
            (gp.project || 0) +
            (gp.finalExam || 0);

        if (sum !== this.totalDegree) {
            this.invalidate(
                "gradingPolicy",
                `Grading policy must sum to exactly ${this.totalDegree}. Current sum: ${sum}`,
            );
        }
    }
});

// ===========================================
// QUERY MIDDLEWARE — Phase 1 isArchived Pattern
// ===========================================

/**
 * Pre-find hook: Auto-filter archived offerings from all queries.
 * Covers: find, findOne, findOneAndUpdate, findOneAndDelete, countDocuments.
 * To include archived documents, pass { isArchived: true } or { isArchived: { $in: [true, false] } }
 * explicitly in the filter.
 */
courseOfferingSchema.pre(
    [
        "find",
        "findOne",
        "findOneAndUpdate",
        "findOneAndDelete",
        "countDocuments",
    ],
    function () {
        if (this.getFilter().isArchived === undefined) {
            this.where({ isArchived: false });
        }
    },
);

const CourseOffering = mongoose.model("CourseOffering", courseOfferingSchema);
export default CourseOffering;
