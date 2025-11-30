import mongoose from "mongoose";

const courseCatalogSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, "Course title is required"],
        trim: true
    },
    code: {
        type: String,
        required: [true, "Course code is required"],
        unique: true,
        lowercase: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    creditHours: {
        type: Number,
        required: [true, "Credit hours are required"],
        min: 0
    },
    prerequisites_ids: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "CourseCatalog"
    }],
    department_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        required: [true, "Department is required"]
    },
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const CourseCatalog = mongoose.model("CourseCatalog", courseCatalogSchema);
export default CourseCatalog;
