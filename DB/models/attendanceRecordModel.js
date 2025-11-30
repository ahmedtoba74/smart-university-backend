import mongoose from "mongoose";

const attendanceRecordSchema = new mongoose.Schema({
    session_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AttendanceSession",
        required: [true, "Session ID is required"],
        index: true
    },
    student_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Student ID is required"],
        index: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Compound index to prevent duplicate scans for the same session
attendanceRecordSchema.index({ session_id: 1, student_id: 1 }, { unique: true });

const AttendanceRecord = mongoose.model("AttendanceRecord", attendanceRecordSchema);
export default AttendanceRecord;
