import mongoose from "mongoose";

const announcementSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, "Title is required"],
        trim: true
    },
    content: {
        type: String,
        required: [true, "Content is required"]
    },
    author_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Author is required"]
    },
    scope: {
        level: {
            type: String,
            enum: ['Global', 'Course', 'Department', 'College'],
            required: true
        },
        target: [{
            type: mongoose.Schema.Types.ObjectId,
            // Dynamic ref based on level? Or just store ID.
            // For simplicity, we store ID, application logic handles what it refers to.
        }]
    }
}, { timestamps: true });

const Announcement = mongoose.model("Announcement", announcementSchema);
export default Announcement;
