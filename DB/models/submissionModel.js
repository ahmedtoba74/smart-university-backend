import mongoose from "mongoose";

const submissionSchema = new mongoose.Schema({
    assessment_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Assessment",
        required: [true, "Assessment ID is required"]
    },
    student_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Student ID is required"]
    },
    status: {
        type: String,
        enum: ['in_progress', 'submitted', 'graded'],
        default: 'in_progress'
    },
    submittedAt: {
        type: Date
    },
    totalScore: {
        type: Number,
        default: 0
    },  
    gradedBy_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    answers: [{
        questionId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },
        
        answerText: String, 
        selectedOptionId: mongoose.Schema.Types.ObjectId, // For Single MCQ
        selectedOptionIds: [{ type: mongoose.Schema.Types.ObjectId }], // For Multiple MCQ
        fileUrl: String, 

        score: { 
            type: Number, 
            default: 0 
        }, 
        
        feedback: {
            type: String
        } 
    }]
}, { timestamps: true });

// Ensure one submission per student per assessment
submissionSchema.index({ assessment_id: 1, student_id: 1 }, { unique: true });

const Submission = mongoose.model("Submission", submissionSchema);
export default Submission;