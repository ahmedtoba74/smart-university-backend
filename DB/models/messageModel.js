/**
 * ===================================================================================
 * @file      messageModel.js
 * @desc      Mongoose model for individual messages within an AI chatbot conversation.
 *            The `status` field drives the two-step POST→SSE architecture:
 *            pending (Step 1 saved) → processing (Step 2 claimed) → completed (done).
 *            The 4000-character content limit applies only to user-submitted messages
 *            and is enforced at the controller layer, NOT at the schema level.
 * @module    DB/models/messageModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
    {
        /**
         * Reference to the parent Conversation document.
         */
        conversation_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
        },
        /**
         * Denormalized reference to the owning User.
         * Enables rapid per-user history queries without joins.
         */
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        /**
         * The sender of this message.
         * 'user' indicates a student/doctor/admin query.
         * 'assistant' indicates the AI engine response.
         */
        role: {
            type: String,
            required: true,
            enum: ["user", "assistant"],
        },
        /**
         * The body content of the message.
         * Can contain markdown, code snippets, or raw text.
         * Max length (4000 chars) is validated at the controller level for user messages only.
         */
        content: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
        },
        /**
         * The routing pillar(s) activated to generate this message.
         * Assistant messages only.
         */
        pillarUsed: {
            type: String,
            enum: ["general", "tools", "rag", "tools+rag"],
            default: null,
        },
        /**
         * Log of live tools invoked during response generation.
         * Assistant messages only.
         */
        toolsInvoked: [
            {
                toolName: { type: String, required: true },
                label: { type: String, required: true },
                executedAt: { type: Date, default: Date.now },
            },
        ],
        /**
         * Optional RAG-uploaded file attachment metadata.
         * User messages only.
         */
        fileAttachment: {
            type: {
                fileName: { type: String, required: true },
                fileType: { type: String, required: true },
                fileUrl: { type: String, required: true },
                embeddingStored: { type: Boolean, default: false },
            },
            default: null,
        },
        /**
         * Azure API reported token counts for this turn.
         * Assistant messages only.
         */
        tokensUsed: {
            type: {
                prompt: { type: Number, required: true },
                completion: { type: Number, required: true },
                total: { type: Number, required: true },
            },
            default: null,
        },
        /**
         * Marker indicating this message was the final context message before summarization.
         */
        isContextAnchor: {
            type: Boolean,
            default: false,
        },
        /**
         * Lifecycle status of the message in the two-step execution pattern.
         */
        status: {
            type: String,
            enum: ["pending", "processing", "completed"],
            default: "pending",
            index: true,
        },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// Indexes
messageSchema.index({ conversation_id: 1, createdAt: 1 });
messageSchema.index({ user_id: 1, createdAt: -1 });
messageSchema.index({ conversation_id: 1, isContextAnchor: 1 });
messageSchema.index({ conversation_id: 1, status: 1 });

const Message = mongoose.model("Message", messageSchema);
export default Message;
