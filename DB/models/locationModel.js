import mongoose from "mongoose";

const locationSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Location name is required"],
        trim: true
    },
    /**
     * @field college_id - Scopes the location to a specific college.
     * CollegeAdmin can only manage locations in their own college.
     */
    college_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "College",
        required: [true, "College is required"],
        index: true
    },
    building: {
        type: String,
        trim: true
    },
    floor: {
        type: Number
    },
    roomNumber: {
        type: String,
        trim: true
    },
    capacity: {
        type: Number,
        required: [true, "Capacity is required"],
        min: [1, "Capacity must be at least 1"]
    },
    type: {
        type: String,
        enum: ['lecture_hall', 'lab', 'section_room', 'auditorium'],
        required: [true, "Location type is required"]
    },
    /**
     * @field status - Controls whether the room is available for scheduling.
     * CollegeAdmin can set to 'maintenance' to block RFID attendance and scheduling.
     */
    status: {
        type: String,
        enum: ['active', 'maintenance'],
        default: 'active'
    },
    /**
     * @field readerId - The unique RFID/NFC device ID bound to this room.
     * Required for the QR/RFID attendance system to validate student location.
     */
    readerId: {
        type: String,
        unique: true,
        sparse: true,  // Rooms under maintenance may temporarily have no reader
        index: true,
        trim: true
    },
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// ============================================
// QUERY MIDDLEWARE
// ============================================

/**
 * Automatically excludes archived locations from all queries.
 * Uses array syntax to cover countDocuments (fixes pagination totals).
 * To bypass: explicitly set isArchived in the filter, e.g. { isArchived: true }.
 */
locationSchema.pre(
    ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'countDocuments'],
    function () {
        if (this.getFilter().isArchived === undefined) {
            this.where({ isArchived: false });
        }
    }
);

const Location = mongoose.model("Location", locationSchema);
export default Location;
