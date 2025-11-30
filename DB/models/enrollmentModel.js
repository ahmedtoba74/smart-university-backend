import mongoose from "mongoose";

const enrollmentSchema = new mongoose.Schema({
    student_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Student ID is required"],
        index: true
    },
    course_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CourseOffering",
        required: [true, "Course Offering ID is required"],
        index: true
    },
    semester: {
        type: String,
        required: [true, "Semester is required"],
        index: true
    },
    status: {
        type: String,
        enum: ['enrolled', 'passed', 'failed', 'withdrawn'],
        default: 'enrolled'
    },
    finalAttendancePercentage: {
        type: Number,
        default: 0
    },
    grades: {
        attendance: { type: Number, default: 0 },
        midterm: { type: Number, default: 0 },
        assignments: { type: Number, default: 0 },
        project: { type: Number, default: 0 },
        finalExam: { type: Number, default: 0 },
        finalTotal: { type: Number, default: 0 },
        finalLetter: { type: String, default: null }
    },
    // Snapshotting critical data for historical integrity
    snapshot: {
        courseCode: String,
        courseTitle: String,
        creditHours: Number
    }
}, { timestamps: true });

// Ensure a student can only enroll once in a specific course offering
enrollmentSchema.index({ student_id: 1, course_id: 1 }, { unique: true });

const Enrollment = mongoose.model("Enrollment", enrollmentSchema);
export default Enrollment;
