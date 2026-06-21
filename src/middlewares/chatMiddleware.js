/**
 * ===================================================================================
 * @file      chatMiddleware.js
 * @desc      Middleware for AI chatbot token budget enforcement.
 *            checkTokenBudget: runs ONLY on POST /messages (Step 1 of the two-step
 *            flow). Enforces monthly token limits per role, resets counters on new
 *            calendar month, and attaches usage data to req for post-stream updating.
 *            universityAdmin has unlimited access (limit === 0).
 * @module    src/middlewares/chatMiddleware
 * @requires  Settings, ChatUsage, catchAsync, AppError
 * ===================================================================================
 */

import { getSettingsCache } from "../modules/settings/settingsController.js";
import ChatUsage from "../../DB/models/chatUsageModel.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";

/**
 * Middleware: Enforce monthly AI token budget before processing a chat message.
 *
 * Steps:
 * 1. Fetch role limit from Settings (cached).
 * 2. If limit === 0 (universityAdmin) -> skip all checks, next() immediately.
 * 3. Resolve current month as "YYYY-MM" string.
 * 4. Find or initialize the user's ChatUsage document.
 * 5. If monthYear differs from current -> reset counter (calendar month rollover).
 * 6. If tokensUsedThisMonth >= roleLimit -> 429 hard block.
 * 7. Attach usage and limit to req for post-stream accounting.
 *
 * Applied at route level to POST /messages only (NOT router-wide).
 * The SSE stream endpoint does NOT run this — it assumes budget was already validated.
 *
 * @function checkTokenBudget
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 */
export const checkTokenBudget = catchAsync(async (req, res, next) => {
    // 1. Fetch settings (use cache to avoid DB hit on every message)
    const settings = await getSettingsCache();
    const roleLimit = settings.chatTokenLimitByRole?.[req.user.role] ?? 50000;

    // 2. universityAdmin is unlimited (limit === 0) — skip all checks
    if (roleLimit === 0) {
        req.chatUsage = null;
        req.chatRoleLimit = 0;
        return next();
    }

    // 3. Resolve current calendar month key
    const currentMonthYear = new Date().toISOString().slice(0, 7); // "YYYY-MM"

    // 4. Find existing usage document
    let usage = await ChatUsage.findOne({ user_id: req.user._id });

    // 5. Handle month rollover: if the stored monthYear differs, reset counter
    if (usage && usage.monthYear !== currentMonthYear) {
        usage.tokensUsedThisMonth = 0;
        usage.monthYear = currentMonthYear;
        usage.lastUpdatedAt = new Date();
        await usage.save();
    } else if (!usage) {
        // No document yet — initialize in memory (will be upserted after stream)
        usage = { tokensUsedThisMonth: 0, monthYear: currentMonthYear };
    }

    // 6. Hard block: budget exhausted
    if (usage.tokensUsedThisMonth >= roleLimit) {
        return next(
            new AppError(
                "You have reached your monthly AI usage limit. Your limit resets on the 1st of next month.",
                429
            )
        );
    }

    // 7. Attach to req for post-stream accounting in the stream controller
    req.chatUsage = usage;
    req.chatRoleLimit = roleLimit;
    next();
});
