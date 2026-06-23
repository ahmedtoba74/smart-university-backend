/**
 * ===================================================================================
 * @file      chatUsageModel.js
 * @desc      Mongoose model for tracking monthly AI token consumption per user.
 *            One document per user per calendar month (monthYear key: "YYYY-MM").
 *            The unique compound index { user_id, monthYear } enables atomic upsert
 *            from the checkTokenBudget middleware. Counters reset by writing a new
 *            monthYear value — no cron job required.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/models/chatUsageModel
 */

import mongoose from "mongoose";

const chatUsageSchema = new mongoose.Schema(
    {
        /**
         * The User whose token consumption is tracked.
         */
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        /**
         * The calendar month identifier in YYYY-MM format (e.g., "2026-06").
         */
        monthYear: {
            type: String,
            required: true,
        },
        /**
         * Total tokens (prompt + completion) consumed during the monthYear block.
         */
        tokensUsedThisMonth: {
            type: Number,
            default: 0,
        },
        /**
         * Last update timestamp for this record.
         */
        lastUpdatedAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: true,
    }
);

// Enforce one usage record per user per month. Enables safe atomic upsert.
chatUsageSchema.index({ user_id: 1, monthYear: 1 }, { unique: true });

const ChatUsage = mongoose.model("ChatUsage", chatUsageSchema);
export default ChatUsage;
