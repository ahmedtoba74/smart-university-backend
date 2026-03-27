import mongoose from "mongoose";

const enrollmentSchema = new mongoose.Schema(
    {
        student_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Student ID is required"],
            index: true,
        },
        course_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },
        /**
         * @field catalogCourse_id - References CourseCatalog directly.
         * Required for the partial unique index to support retakes and re-enrollment,
         * and for the optimized Gate 3 prerequisite query.
         */
        catalogCourse_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseCatalog",
            required: [true, "Catalog Course ID is required"],
            index: true,
        },
        /**
         * @field college_id - For fast IDOR scoping via req.scopeFilter explicitly
         * so college admins can query enrollments natively without joining offering.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },
        semester: {
            type: String,
            required: [true, "Semester is required"],
            index: true,
        },
        /**
         * @field academicYear - Needed for credit-limit aggregation and term filtering.
         */
        academicYear: {
            type: String,
            required: [true, "Academic Year is required"],
            index: true,
        },
        status: {
            type: String,
            enum: ["enrolled", "passed", "failed", "withdrawn"],
            default: "enrolled",
        },
        finalAttendancePercentage: {
            type: Number,
            default: 0,
        },
        grades: {
            attendance: { type: Number, default: 0 },
            midterm: { type: Number, default: 0 },
            assignments: { type: Number, default: 0 },
            project: { type: Number, default: 0 },
            finalExam: { type: Number, default: 0 },
            finalTotal: { type: Number, default: 0 },
            finalLetter: { type: String, default: null },
        },
        // Snapshotting critical data for historical integrity
        snapshot: {
            courseCode: String,
            courseTitle: String,
            creditHours: Number,
        },
        /**
         * @field forceEnrolled - Audit trail for admin overrides.
         * Only populated when POST /enrollments/force is used.
         */
        forceEnrolled: {
            forcedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            forcedAt: Date,
            gatesBypassed: [String],
            overrideCapacity: Boolean,
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
 * Replaces old { student_id, course_id }.
 * Allows retakes across semesters (different academicYear/semester),
 * and allows re-enrollment after withdrawal in the SAME semester
 * because 'withdrawn' status is excluded from the partial match.
 * Prevents double-enrollment in the same catalog course while active.
 */
enrollmentSchema.index(
    { student_id: 1, catalogCourse_id: 1, semester: 1, academicYear: 1 },
    {
        unique: true,
        partialFilterExpression: {
            status: { $in: ["enrolled", "passed", "failed"] },
        },
    },
);

/**
 * 2. Gate 3 Prerequisite Optimization Index
 * Supports: Enrollment.find({ student_id, catalogCourse_id: { $in }, status: 'passed' })
 */
enrollmentSchema.index({ student_id: 1, catalogCourse_id: 1, status: 1 });

/**
 * 3. Gate 2 Credit Limit Hot-Path Index
 * Covers the $match stage of the aggregation pipeline running inside the transaction.
 */
enrollmentSchema.index({
    student_id: 1,
    semester: 1,
    academicYear: 1,
    status: 1,
});

const Enrollment = mongoose.model("Enrollment", enrollmentSchema);
export default Enrollment;
