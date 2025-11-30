import mongoose from "mongoose";

const materialSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, "Title is required"],
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    courseOffering_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CourseOffering",
        required: [true, "Course Offering ID is required"],
        index: true
    },
    category: {
        type: String,
        enum: ['Lectures', 'Sheets', 'Readings', 'Links'],
        required: true
    },
    isExternalLink: {
        type: Boolean,
        default: false
    },
    url: {
        type: String,
        required: [true, "URL is required"]
    },
    fileName: String,
    fileType: String,
    uploadedBy_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    }
}, { timestamps: true });

const Material = mongoose.model("Material", materialSchema);
export default Material;
