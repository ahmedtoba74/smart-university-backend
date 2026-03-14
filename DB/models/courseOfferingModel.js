import mongoose from "mongoose";

const courseOfferingSchema = new mongoose.Schema({
    course_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CourseCatalog",
        required: [true, "Course Catalog ID is required"]
    },
    /**
     * @field college_id - Denormalized from course_id → department → college for fast scoping.
     * Set automatically by the controller when creating a new offering.
     * Allows a single-query filter: CourseOffering.find({ college_id }) for collegeAdmin.
     */
    college_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "College",
        required: [true, "College ID is required"],
        index: true
    },
    semester: {
        type: String,
        required: [true, "Semester is required"],
        index: true,
        trim: true
    },
    doctors_ids: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],
    tas_ids: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],
    schedule: [{
    day: {
        type: String,
        enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        required: true
    },
    startTime: {
        type: String,
        required: true,
        validate: {
            validator: function(v) {
                return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: props => `${props.value} is not a valid time format (HH:MM)!`
        }
    },
    endTime: {
        type: String,
        required: true,
        validate: {
            validator: function(v) {
                return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: props => `${props.value} is not a valid time format (HH:MM)!`
        }
    },
    location: {
        type: mongoose.Schema.Types.ObjectId, // Changed to Ref for RFID consistency
        ref: 'Location', 
        required: true
    },
    sessionType: {
        type: String,
        enum: ['lecture', 'lab', 'section'],
        required: true
    }
    }],
    maxSeats: {
        type: Number,
        default: 50
    },
    currentEnrolled: {
        type: Number,
        default: 0
    },
    gradingPolicy: {
        attendance: { type: Number, default: 0 },
        midterm: { type: Number, default: 0 },
        assignments: { type: Number, default: 0 },
        project: { type: Number, default: 0 },
        finalExam: { type: Number, default: 0 }
    },
    /**
     * @field semesterWorkLocked - Set to true when doctor clicks "Submit Semester Work".
     * Once locked, no further edits to midterm/assignments/attendance grades are allowed.
     * The finalExam grade (entered by collegeAdmin/Kontrol) is unaffected.
     */
    semesterWorkLocked: {
        type: Boolean,
        default: false
    },
    /**
     * @field resultsPublished - Set to true by collegeAdmin after GPA calculation is complete.
     * Controls visibility: students cannot see finalTotal or finalLetter until this is true.
     */
    resultsPublished: {
        type: Boolean,
        default: false
    },
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Compound index for efficient querying
courseOfferingSchema.index({ semester: 1, course_id: 1 }, { unique: true });

courseOfferingSchema.pre('validate', function(next) {
    if (this.schedule) {
        for (const session of this.schedule) {
            if (session.startTime >= session.endTime) {
                this.invalidate('schedule', `Start time (${session.startTime}) must be before End time (${session.endTime})`);
            }
        }
    }
    next();
});


const CourseOffering = mongoose.model("CourseOffering", courseOfferingSchema);
export default CourseOffering;
