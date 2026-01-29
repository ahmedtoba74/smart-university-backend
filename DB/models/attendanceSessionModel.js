import mongoose from "mongoose";

const attendanceSessionSchema = new mongoose.Schema({
    courseOffering_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CourseOffering",
        required: [true, "Course Offering ID is required"]
    },
    location_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Location",
        required: [true, "Location ID is required"]
    },
    initiatedBy_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Initiator is required"]
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: [true, "Expiration time is required"],
        index: { expireAfterSeconds: 0 } 
    }
}, { timestamps: true });

const AttendanceSession = mongoose.model("AttendanceSession", attendanceSessionSchema);
export default AttendanceSession;
