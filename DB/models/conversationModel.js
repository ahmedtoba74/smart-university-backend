/**
 * ===================================================================================
 * @file      conversationModel.js
 * @desc      Mongoose model for AI chatbot conversations. Each document represents
 *            one conversation thread per user. Conversations are hard-deleted (not
 *            soft-deleted) — no isArchived field or pre-find hook is defined.
 *            Cascade deletion (messages + RAG chunks) is handled in chatController.js.
 * @module    DB/models/conversationModel
 * @requires  mongoose
 * ===================================================================================
 */

import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
    {
        /**
         * Reference to the User who owns this conversation.
         * Enforces role-based isolation.
         */
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        /**
         * Auto-generated or custom title for the conversation.
         * Stored with HTML tags stripped for defense-in-depth against stored XSS.
         */
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
        },
        /**
         * Consolidated context summary of the conversation history.
         * Updated on each token-triggered summarization cycle.
         */
        contextSummary: {
            type: String,
            default: null,
        },
        /**
         * Count of how many times the conversation history has been summarized.
         */
        summarizationCycles: {
            type: Number,
            default: 0,
        },
        /**
         * True if the summarization limit is reached.
         * Sealed conversations reject new messages with a 409 error.
         */
        isSealed: {
            type: Boolean,
            default: false,
        },
        /**
         * Informational total of all Azure OpenAI tokens used by this conversation.
         */
        totalTokensUsed: {
            type: Number,
            default: 0,
        },
        /**
         * Set to true if any message in this conversation had a RAG file attachment.
         */
        hasRagContext: {
            type: Boolean,
            default: false,
        },
        /**
         * Running count of messages in this conversation.
         */
        messageCount: {
            type: Number,
            default: 0,
        },
        /**
         * Tenant college identifier denormalized from user.college_id.
         * Null for universityAdmin users.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes for query performance and sliding window eviction
conversationSchema.index({ user_id: 1, createdAt: -1 });
conversationSchema.index({ user_id: 1, isSealed: 1 });
conversationSchema.index({ user_id: 1, updatedAt: -1 });
conversationSchema.index({ college_id: 1 }, { sparse: true });

const Conversation = mongoose.model("Conversation", conversationSchema);
export default Conversation;
