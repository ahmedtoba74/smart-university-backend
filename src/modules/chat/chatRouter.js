/**
 * ===================================================================================
 * @file      chatRouter.js
 * @desc      Express router for the Phase 7 AI chatbot engine.
 *            Middleware stack: protect → enforcePasswordChange → attachCollegeScope
 *            checkTokenBudget is applied ONLY to POST /messages (Step 1 of two-step flow).
 *            The SSE stream endpoint (GET /stream) does NOT run checkTokenBudget —
 *            budget was already validated in Step 1.
 *            Multer config: PDF + text/plain only, 10MB max.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/modules/chat/chatRouter
 */

import express from "express";
import multer from "multer";
import {
    protect,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";
import { checkTokenBudget } from "../../middlewares/chatMiddleware.js";
import * as chatController from "./chatController.js";
import AppError from "../../utils/appError.js";

const router = express.Router();

// ── Global middleware for all chat routes ────────────────────────────────────
// protect: verifies JWT and attaches req.user
// enforcePasswordChange: blocks if temporary password not changed
// attachCollegeScope: sets req.scopeFilter — required by all tools
router.use(protect);
router.use(enforcePasswordChange);
router.use(attachCollegeScope);

// ── Chat-specific Multer configuration ──────────────────────────────────────
// Separate from the global upload endpoint — chat has its own file type limits.
// Magic byte validation is performed in the controller after Multer accepts the file.
const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowed = ["application/pdf", "text/plain"];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(
                new AppError(
                    "Only PDF and plain text files are supported for chat attachments.",
                    415,
                ),
                false,
            );
        }
    },
});

// Custom wrapper to format Multer upload errors
const handleChatUpload = (req, res, next) => {
    chatUpload.single("file")(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                    return next(
                        new AppError(
                            "File too large. Maximum size is 10MB.",
                            413,
                        ),
                    );
                }
                return next(new AppError(err.message, 400));
            }
            return next(err);
        }
        next();
    });
};

// ── Conversation management ──────────────────────────────────────────────────
// ...
router.post("/conversations", chatController.createConversation);
router.get("/conversations", chatController.listConversations);
router.get("/conversations/:id", chatController.getConversation);
router.patch("/conversations/:id", chatController.renameConversation);
router.delete("/conversations/:id", chatController.deleteConversation);

// ── Two-step messaging flow ──────────────────────────────────────────────────
// Step 1: POST /messages — validate budget, save user message, return messageId
// checkTokenBudget runs ONLY here (not on GET /stream)
router.post(
    "/conversations/:id/messages",
    checkTokenBudget, // ← Budget enforcement: POST only (see RESIDUAL-3 fix)
    chatController.sendMessage,
);

// Step-2: GET /stream — claim pending message, execute agent, stream via SSE
// No checkTokenBudget here — budget already validated in Step 1
router.get("/conversations/:id/stream", chatController.streamResponse);

// ── RAG file upload ──────────────────────────────────────────────────────────
// Magic byte validation happens in the controller after this Multer check
router.post(
    "/conversations/:id/upload",
    handleChatUpload,
    chatController.uploadRagFile,
);

// ── Usage reporting ──────────────────────────────────────────────────────────
router.get("/usage", chatController.getUsage);

export default router;
