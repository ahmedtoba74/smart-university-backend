import mongoose from "mongoose";

const departmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Department name is required"],
        trim: true
    },
    code: {
        type: String,
        required: [true, "Department code is required"],
        unique: true,
        lowercase: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    head_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    college_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "College",
        required: [true, "College is required"],
        index: true
    },
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const Department = mongoose.model("Department", departmentSchema);
export default Department;
