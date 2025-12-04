import mongoose from "mongoose";

const assessmentSchema = new mongoose.Schema({
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
    totalPoints: {
        type: Number,
        default: 0
    },
    dueDate: {
        type: Date,
        required: true
    },
    questions: [{
        questionText: { type: String, required: true },
        order: { type: Number, default: 0 },
        attachments: [{
            fileName: String,
            fileUrl: String
        }],
        questionType: {
            type: String,
            enum: ['MCQ-Single', 'MCQ-Multiple', 'TrueFalse', 'Short-Answer', 'Paragraph', 'FileUpload'],
            required: true
        },
        isRequired: {
            type: Boolean,
            default: true
        },
        options: [{
            text: String,
            isCorrect: { 
                type: Boolean, 
                default: false,
                select: false 
            }
        }],
        shuffleOptions: { type: Boolean, default: false },
        validation: {
            regex: String,
            minLength: Number,
            maxLength: Number
        },
        modelAnswer: { 
            type: String,
            select: false 
        }, 
        points: { type: Number, required: true }
    }],
    
    settings: {
        shuffleQuestions: { type: Boolean, default: false },
        allowEditAfterSubmit: { type: Boolean, default: false },
        limitToOneResponse: { type: Boolean, default: true },
        showGradesImmediately: { type: Boolean, default: false },
        acceptingResponses: { type: Boolean, default: true },
        confirmationMessage: { type: String, default: "Your response has been recorded." }
    },

    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const Assessment = mongoose.model("Assessment", assessmentSchema);
export default Assessment;
