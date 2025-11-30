import mongoose from "mongoose";

const collegeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "College name is required"],
        unique: true,
        trim: true
    },
    code: {
        type: String,
        required: [true, "College code is required"],
        unique: true,
        lowercase: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    dean_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Dean is required"]
    },
    department_ids: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
    }],
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const College = mongoose.model("College", collegeSchema);
export default College;
