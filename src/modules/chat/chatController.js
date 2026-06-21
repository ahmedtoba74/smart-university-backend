/**
 * ===================================================================================
 * @file      chatController.js
 * @desc      Controller for the Phase 7 AI chatbot engine.
 *            Handles conversation lifecycle, message persistence, SSE streaming,
 *            RAG file upload, and token usage reporting.
 *            Two-step message flow: POST /messages (Step 1) → GET /stream (Step 2).
 *            SSE error handling uses a dedicated try/catch after header flush —
 *            the global error handler CANNOT be used post-flush (ERR_HTTP_HEADERS_SENT).
 * @module    src/modules/chat/chatController
 * @requires  catchAsync, AppError, Conversation, Message, RagChunk, ChatUsage,
 *            Settings, chatService, uploadHelper
 * ===================================================================================
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

import mongoose from "mongoose";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import Conversation from "../../../DB/models/conversationModel.js";
import Message from "../../../DB/models/messageModel.js";
import RagChunk from "../../../DB/models/ragChunkModel.js";
import ChatUsage from "../../../DB/models/chatUsageModel.js";
import { getSettingsCache } from "../settings/settingsController.js";
import {
    deleteFromCloudinary,
    uploadToCloudinary,
} from "../../utils/uploadHelper.js";
import {
    streamAgent,
    classifyAzureError,
    embeddingModel,
} from "../../services/chatService.js";

// ===================================================================================
// 11.2 — CREATE CONVERSATION
// ===================================================================================

/**
 * Creates a new chatbot conversation thread for the requesting user.
 * Implements a sliding window history limit (default 20): evicts oldest conversation
 * and its messages/RAG chunks atomically via a Mongoose transaction.
 *
 * @route   POST /api/v1/chat/conversations
 * @access  All authenticated users
 */
export const createConversation = catchAsync(async (req, res, next) => {
    // 1. Fetch academic settings (cached to prevent database load)
    const settings = await getSettingsCache();
    const limit = settings.chatHistoryLimit ?? 20;

    const session = await mongoose.startSession();
    let newConversation;
    const urlsToDelete = [];

    try {
        await session.withTransaction(async () => {
            // Count current user conversations inside the transaction
            const count = await Conversation.countDocuments({
                user_id: req.user._id,
            }).session(session);

            if (count >= limit) {
                // Retrieve the oldest conversation to evict
                const oldest = await Conversation.findOne({
                    user_id: req.user._id,
                })
                    .sort({ createdAt: 1 })
                    .session(session);

                if (oldest) {
                    // Fetch any messages containing attachments that need Cloudinary deletion
                    const messagesWithFiles = await Message.find({
                        conversation_id: oldest._id,
                        "fileAttachment.fileUrl": { $ne: null },
                    })
                        .select("fileAttachment.fileUrl")
                        .session(session);

                    // Collect Cloudinary URLs for post-commit cleanup
                    messagesWithFiles.forEach((msg) => {
                        if (msg.fileAttachment?.fileUrl) {
                            urlsToDelete.push(msg.fileAttachment.fileUrl);
                        }
                    });

                    // Cascade delete database records
                    await RagChunk.deleteMany({
                        conversation_id: oldest._id,
                    }).session(session);
                    await Message.deleteMany({
                        conversation_id: oldest._id,
                    }).session(session);
                    await Conversation.deleteOne({ _id: oldest._id }).session(
                        session,
                    );
                }
            }

            // Create the new conversation document inside the transaction
            // Note: create() must receive documents as an array when using session options
            const payload = {
                user_id: req.user._id,
                college_id: req.user.college_id ?? null, // Null for universityAdmin
                title: "New Conversation", // Updated dynamically on first message
                contextSummary: null,
                summarizationCycles: 0,
                isSealed: false,
                totalTokensUsed: 0,
                messageCount: 0,
                hasRagContext: false,
            };

            const [created] = await Conversation.create([payload], { session });
            newConversation = created;
        });

        // Trigger Cloudinary cleanup only after successful transaction commit
        urlsToDelete.forEach((url) => {
            deleteFromCloudinary(url).catch((err) =>
                console.warn(
                    `[chatController] Cloudinary cleanup failed for ${url}:`,
                    err.message,
                ),
            );
        });
    } finally {
        await session.endSession();
    }

    res.status(201).json({
        status: "success",
        data: {
            conversation: newConversation,
        },
    });
});

// ===================================================================================
// 11.3 — LIST CONVERSATIONS
// ===================================================================================

/**
 * Returns a paginated list of conversations owned by the authenticated user.
 * Sorted chronologically descending by last updated timestamp.
 *
 * @route   GET /api/v1/chat/conversations
 * @access  All authenticated users
 */
export const listConversations = catchAsync(async (req, res, next) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Limit is capped at a maximum of 100 to prevent database overload
    const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 20, 1),
        100,
    );
    const skip = (page - 1) * limit;

    const [conversations, totalResults] = await Promise.all([
        Conversation.find({ user_id: req.user._id })
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Conversation.countDocuments({ user_id: req.user._id }),
    ]);

    res.status(200).json({
        status: "success",
        results: conversations.length,
        currentPage: page,
        totalPages: Math.ceil(totalResults / limit),
        totalResults,
        data: {
            conversations,
        },
    });
});

// ===================================================================================
// 11.4 — GET CONVERSATION
// ===================================================================================

/**
 * Retrieves a single conversation metadata along with its paginated message history.
 * Enforces ownership boundary: returns 404 (not 403) on mismatch to prevent IDOR scanning.
 *
 * @route   GET /api/v1/chat/conversations/:id
 * @access  All authenticated users (owners only)
 */
export const getConversation = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 1. Fetch conversation and enforce strict user ownership
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user_id: req.user._id,
    });

    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 2. Fetch conversation message history sorted chronologically
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Limit is capped at a maximum of 100 to prevent database overload
    const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 50, 1),
        100,
    );
    const skip = (page - 1) * limit;

    const [messages, totalResults] = await Promise.all([
        Message.find({ conversation_id: conversation._id })
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Message.countDocuments({ conversation_id: conversation._id }),
    ]);

    res.status(200).json({
        status: "success",
        data: {
            conversation,
            messages,
            pagination: {
                page,
                limit,
                totalPages: Math.ceil(totalResults / limit),
                totalResults,
            },
        },
    });
});

// ===================================================================================
// 11.5 — DELETE CONVERSATION
// ===================================================================================

/**
 * Hard-deletes a conversation thread and cascade deletes all messages and RAG chunks.
 * Enforces ownership boundary. Fire-and-forget Cloudinary file attachments cleanup.
 *
 * @route   DELETE /api/v1/chat/conversations/:id
 * @access  All authenticated users (owners only)
 */
export const deleteConversation = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 1. Verify existence and ownership
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user_id: req.user._id,
    });

    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 2. Query messages containing file uploads for Cloudinary storage removal
    const messagesWithFiles = await Message.find({
        conversation_id: conversation._id,
        "fileAttachment.fileUrl": { $ne: null },
    })
        .select("fileAttachment.fileUrl")
        .lean();

    const urlsToDelete = messagesWithFiles
        .map((msg) => msg.fileAttachment?.fileUrl)
        .filter(Boolean);

    // 3. Atomic cascade deletion in a MongoDB transaction
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await RagChunk.deleteMany({
                conversation_id: conversation._id,
            }).session(session);
            await Message.deleteMany({
                conversation_id: conversation._id,
            }).session(session);
            await Conversation.deleteOne({ _id: conversation._id }).session(
                session,
            );
        });

        // Trigger Cloudinary cleanup only after successful transaction commit
        urlsToDelete.forEach((url) => {
            deleteFromCloudinary(url).catch((err) =>
                console.warn(
                    `[chatController] Cloudinary cleanup failed for ${url}:`,
                    err.message,
                ),
            );
        });
    } finally {
        await session.endSession();
    }

    res.status(204).json({
        status: "success",
        data: null,
    });
});

// ===================================================================================
// 11.6 — RENAME CONVERSATION
// ===================================================================================

/**
 * Updates a conversation's title.
 * Enforces ownership boundary. Sanitizes inputs for XSS protection.
 *
 * @route   PATCH /api/v1/chat/conversations/:id
 * @access  All authenticated users (owners only)
 */
export const renameConversation = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    if (!req.body.title || req.body.title.trim().length === 0) {
        return next(new AppError("Title is required.", 400));
    }

    // Stored XSS defense: strip HTML tags and limit length
    const cleanTitle = req.body.title
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 100);

    if (cleanTitle.length === 0) {
        return next(new AppError("Invalid title.", 400));
    }

    // Atomic find and update with IDOR check
    const conversation = await Conversation.findOneAndUpdate(
        { _id: req.params.id, user_id: req.user._id },
        { $set: { title: cleanTitle } },
        { new: true, runValidators: true },
    );

    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }

    res.status(200).json({
        status: "success",
        data: {
            conversation,
        },
    });
});

// ===================================================================================
// 12.1 — SEND MESSAGE (Step 1)
// ===================================================================================

/**
 * Validates and persists a user message to the database as 'pending'.
 * Does not invoke the AI agent. The client must call the /stream endpoint next.
 *
 * @route   POST /api/v1/chat/conversations/:id/messages
 * @access  All authenticated users (owners only)
 */
export const sendMessage = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 1. Content validation
    const trimmedContent = req.body.content ? req.body.content.trim() : "";
    if (trimmedContent.length === 0) {
        return next(new AppError("Message content cannot be empty.", 400));
    }
    if (trimmedContent.length > 4000) {
        return next(
            new AppError("Message content cannot exceed 4000 characters.", 400),
        );
    }

    // 2. Ownership & Sealed check
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user_id: req.user._id,
    });
    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }
    if (conversation.isSealed) {
        return next(
            new AppError(
                "This conversation is sealed and cannot accept new messages.",
                409,
            ),
        );
    }

    // 3. Save user message with status: 'pending'
    const message = await Message.create({
        conversation_id: conversation._id,
        user_id: req.user._id,
        role: "user",
        content: trimmedContent,
        status: "pending",
    });

    // 4. Auto-title on first message
    if (conversation.messageCount === 0) {
        conversation.title = trimmedContent
            .replace(/<[^>]*>/g, "") // Strip HTML tags (stored XSS defense)
            .slice(0, 60)
            .trim();
    }

    // 5. Update messageCount and save conversation
    conversation.messageCount += 1;
    await conversation.save();

    res.status(201).json({
        status: "success",
        data: {
            messageId: message._id,
            conversationId: conversation._id,
        },
    });
});

// ===================================================================================
// 12.2 — STREAM RESPONSE (Step 2)
// ===================================================================================

/**
 * Claims a pending user message and streams the AI agent's response as SSE.
 * Errors inside the SSE stream are written as structured SSE data events,
 * and the user's message is rolled back to 'pending' on failure.
 *
 * @route   GET /api/v1/chat/conversations/:id/stream
 * @access  All authenticated users (owners only)
 */
export const streamResponse = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    // ── PRE-SSE PHASE ──────────────────────────────────────────────────────────────────

    // 1. Ownership check
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user_id: req.user._id,
    });
    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }

    // Check if a stream is already in progress for this conversation
    const activeStream = await Message.findOne({
        conversation_id: conversation._id,
        status: "processing",
    });
    if (activeStream) {
        return next(new AppError("A stream is already in progress.", 409));
    }

    // 2. Atomic claim: pending → processing
    const pendingMessage = await Message.findOneAndUpdate(
        { conversation_id: conversation._id, role: "user", status: "pending" },
        { $set: { status: "processing" } },
        { sort: { createdAt: -1 }, new: true },
    );
    if (!pendingMessage) {
        return next(
            new AppError(
                "No pending message to process. Send a message first via POST /messages.",
                400,
            ),
        );
    }

    // ── SSE PHASE ──────────────────────────────────────────────────────────────────────

    // 3. Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Helper: roll back message to 'pending' on failure
    const rollbackMessage = async () => {
        try {
            await Message.updateOne(
                { _id: pendingMessage._id },
                { $set: { status: "pending" } },
            );
        } catch (e) {
            console.error(
                "[streamResponse] Failed to roll back message status:",
                e.message,
            );
        }
    };

    // Helper: send SSE error and close
    const sendSseError = (errorMsg) => {
        streamAborted = true; // prevent req.on('close') from executing rollback
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.end();
    };

    // 4. 120-second timeout
    let streamAborted = false;
    const sseTimeout = setTimeout(async () => {
        streamAborted = true;
        await rollbackMessage();
        sendSseError("The response took too long. Please try again.");
    }, 120000);

    // 5. Disconnect handler
    req.on("close", async () => {
        if (streamAborted) return;
        streamAborted = true;
        clearTimeout(sseTimeout);
        await rollbackMessage();
    });

    // 6. Stream agent (try/catch — SSE error format)
    try {
        const agentResult = await streamAgent({
            userMessage: pendingMessage.content,
            user: req.user,
            scopeFilter: req.scopeFilter,
            conversationId: conversation._id,
            conversation,
            onToken: (token) => {
                if (streamAborted) return;
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
            },
            onToolCall: (toolName, label) => {
                if (streamAborted) return;
                res.write(
                    `data: ${JSON.stringify({ toolCall: toolName, label })}\n\n`,
                );
            },
        });

        if (streamAborted) return;
        clearTimeout(sseTimeout);
        streamAborted = true; // prevent req.on('close') from executing rollback

        // 7. Save assistant message
        const assistantMsg = await Message.create({
            conversation_id: conversation._id,
            user_id: req.user._id,
            role: "assistant",
            content: agentResult.response,
            toolsInvoked: agentResult.toolsInvoked,
            pillarUsed: agentResult.pillarUsed,
            tokensUsed: agentResult.tokensUsed,
            status: "completed",
        });

        // 8. Mark user message completed
        await Message.updateOne(
            { _id: pendingMessage._id },
            { $set: { status: "completed" } },
        );

        // 9. Update conversation stats
        conversation.messageCount += 1;
        conversation.totalTokensUsed += agentResult.tokensUsed?.total ?? 0;
        await conversation.save();

        // 10. Update chat usage
        const currentMonthYear = new Date().toISOString().slice(0, 7);
        const tokensToAdd = agentResult.tokensUsed?.total ?? 0;
        await ChatUsage.findOneAndUpdate(
            { user_id: req.user._id, monthYear: currentMonthYear },
            {
                $inc: { tokensUsedThisMonth: tokensToAdd },
                $set: { lastUpdatedAt: new Date() },
            },
            { upsert: true, new: true },
        );

        // 11. Soft warning at 80% budget (Independent settings fetch)
        const settings = await getSettingsCache();
        const roleLimit =
            settings.chatTokenLimitByRole?.[req.user.role] ?? 50000;

        let finalResponse = agentResult.response;
        if (roleLimit && roleLimit > 0) {
            const updatedUsage = await ChatUsage.findOne({
                user_id: req.user._id,
                monthYear: currentMonthYear,
            });
            if (updatedUsage) {
                const pct = updatedUsage.tokensUsedThisMonth / roleLimit;
                if (pct >= 0.8) {
                    const remaining =
                        roleLimit - updatedUsage.tokensUsedThisMonth;
                    finalResponse += `\n\n---\n⚠️ You've used over 80% of your monthly AI usage budget. Approximately ${remaining} tokens remaining this month.`;
                    // Update assistant message with warning appended
                    await Message.updateOne(
                        { _id: assistantMsg._id },
                        { $set: { content: finalResponse } },
                    );
                }
            }
        }

        // 12. Send done event
        res.write(
            `data: ${JSON.stringify({
                done: true,
                messageId: assistantMsg._id,
                toolsInvoked: agentResult.toolsInvoked,
            })}\n\n`,
        );
        res.end();
    } catch (err) {
        if (streamAborted) return;
        clearTimeout(sseTimeout);

        // Classify Azure-specific errors
        const errType = classifyAzureError(err);
        let userMessage = "Something went wrong. Please try again.";

        if (errType === "content_filter") {
            userMessage =
                "I'm unable to respond to that message. Please rephrase your question.";
        } else if (errType === "token_limit") {
            userMessage =
                "This conversation's context is too large. Please start a new chat.";
            // Seal the conversation
            await Conversation.updateOne(
                { _id: conversation._id },
                { $set: { isSealed: true } },
            ).catch(() => {});
        } else if (errType === "timeout") {
            userMessage =
                "The AI service took too long to respond. Please try again.";
        }

        console.error("[streamResponse] Agent error:", err.message);
        await rollbackMessage();
        sendSseError(userMessage);
    }
});

// ===================================================================================
// 13.1 — UPLOAD RAG FILE
// ===================================================================================

/**
 * Splits text into sentence-boundary-aware chunks not exceeding maxChars.
 *
 * @param {string} text - The input text to chunk.
 * @param {number} maxChars - Maximum characters per chunk (approx. 500 tokens).
 * @returns {string[]} Array of chunked text blocks.
 */
function splitIntoChunks(text, maxChars = 2000) {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    const chunks = [];
    let currentChunk = "";

    for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) continue;

        if (sentence.length > maxChars) {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = "";
            }
            let start = 0;
            while (start < sentence.length) {
                chunks.push(sentence.slice(start, start + maxChars));
                start += maxChars;
            }
            continue;
        }

        if (currentChunk.length + sentence.length + 1 > maxChars) {
            chunks.push(currentChunk);
            currentChunk = sentence;
        } else {
            currentChunk = currentChunk
                ? `${currentChunk} ${sentence}`
                : sentence;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Uploads a document (PDF or TXT), extracts its text, chunks it, embeds chunks,
 * stores chunks in DB, and uploads the file to Cloudinary for reference.
 *
 * @route   POST /api/v1/chat/conversations/:id/upload
 * @access  All authenticated users (owners only)
 */
export const uploadRagFile = catchAsync(async (req, res, next) => {
    // Validate ObjectId format to prevent CastErrors and leak of details (retains IDOR 404)
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Conversation not found.", 404));
    }

    // 1. Verify existence and ownership
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user_id: req.user._id,
    });
    if (!conversation) {
        return next(new AppError("Conversation not found.", 404));
    }
    if (conversation.isSealed) {
        return next(
            new AppError(
                "This conversation has reached its limit. Please start a new chat.",
                409,
            ),
        );
    }

    // 2. File existence check
    if (!req.file) {
        return next(new AppError("No file uploaded.", 400));
    }

    // 3. Magic byte validation for PDFs
    if (req.file.mimetype === "application/pdf") {
        const magic = req.file.buffer.slice(0, 5).toString("ascii");
        if (magic !== "%PDF-") {
            return next(
                new AppError(
                    "Invalid file content. Expected a valid PDF document.",
                    415,
                ),
            );
        }
    }

    // 4. Text extraction
    let text = "";
    if (req.file.mimetype === "application/pdf") {
        try {
            const parsed = await pdfParse(req.file.buffer);
            text = parsed.text || "";
        } catch (err) {
            return next(new AppError("Failed to parse PDF file content.", 400));
        }
    } else if (req.file.mimetype === "text/plain") {
        text = req.file.buffer.toString("utf-8");
    } else {
        return next(
            new AppError(
                "Unsupported file type. Only PDF and TXT files are allowed.",
                400,
            ),
        );
    }

    if (!text.trim()) {
        return next(
            new AppError("Uploaded file contains no extractable text.", 400),
        );
    }

    // 5. Chunking (~500 tokens ≈ 2000 chars, sentence-boundary-aware)
    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) {
        return next(
            new AppError(
                "Uploaded file contains no extractable text chunks.",
                400,
            ),
        );
    }

    // Protection against Azure TPM limit exhaustion and resource bloat
    if (chunks.length > 100) {
        return next(
            new AppError(
                "File content is too large. Maximum document size is capped at 100 sections (approx. 50,000 tokens).",
                400,
            ),
        );
    }

    // 6. Embedding (batch call)
    let embeddings;
    try {
        embeddings = await embeddingModel.embedDocuments(chunks);
    } catch (err) {
        console.error(
            "[uploadRagFile] Embeddings generation failed:",
            err.message,
        );
        return next(
            new AppError(
                "Failed to generate vector embeddings for file content.",
                500,
            ),
        );
    }

    // 7. Cloudinary upload (for reference)
    let cloudinaryResult;
    try {
        cloudinaryResult = await uploadToCloudinary(
            req.file.buffer,
            "chat-attachments",
            true,
        );
    } catch (err) {
        console.error("[uploadRagFile] Cloudinary upload failed:", err.message);
        return next(
            new AppError(
                "Failed to upload file attachment to cloud storage.",
                500,
            ),
        );
    }

    // 8. Store RAG chunks and update conversation inside a Mongoose transaction to ensure atomicity
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const ragChunks = chunks.map((content, i) => ({
                conversation_id: conversation._id,
                user_id: req.user._id,
                message_id: null,
                college_id: req.user.college_id ?? null,
                content,
                embedding: embeddings[i],
                chunkIndex: i,
                fileName: req.file.originalname,
            }));

            await RagChunk.insertMany(ragChunks, { session });

            // Update conversation status
            conversation.hasRagContext = true;
            await conversation.save({ session });
        });
    } catch (dbErr) {
        // Rollback Cloudinary if database transaction fails to prevent orphan-file leaks
        if (cloudinaryResult?.secure_url) {
            deleteFromCloudinary(cloudinaryResult.secure_url).catch((err) =>
                console.warn(
                    `[uploadRagFile] Failed to clean up orphaned Cloudinary file:`,
                    err.message,
                ),
            );
        }
        console.error(
            "[uploadRagFile] Database transaction failed:",
            dbErr.message,
        );
        return next(
            new AppError(
                "Failed to save document index chunks to database.",
                500,
            ),
        );
    } finally {
        await session.endSession();
    }

    // 10. Return success response
    res.status(200).json({
        status: "success",
        data: {
            chunksCreated: chunks.length,
            fileName: req.file.originalname,
            fileUrl: cloudinaryResult.secure_url,
        },
    });
});

// ===================================================================================
// 13.2 — GET USAGE
// ===================================================================================

/**
 * Retrieves the current user's monthly AI token usage and limit settings.
 * Returns percentage used, remaining tokens, and if usage is unlimited.
 *
 * @route   GET /api/v1/chat/usage
 * @access  All authenticated users
 */
export const getUsage = catchAsync(async (req, res, next) => {
    const currentMonthYear = new Date().toISOString().slice(0, 7);

    // Query current usage document
    const usage = await ChatUsage.findOne({
        user_id: req.user._id,
        monthYear: currentMonthYear,
    });
    const tokensUsed = usage?.tokensUsedThisMonth ?? 0;

    // Load academic settings configuration
    const settings = await getSettingsCache();
    const limit = settings.chatTokenLimitByRole?.[req.user.role] ?? 50000;
    const isUnlimited = limit === 0;

    res.status(200).json({
        status: "success",
        data: {
            monthYear: currentMonthYear,
            tokensUsed,
            tokenLimit: limit,
            isUnlimited,
            percentageUsed: isUnlimited
                ? 0
                : Math.round((tokensUsed / limit) * 100),
            remainingTokens: isUnlimited
                ? null
                : Math.max(0, limit - tokensUsed),
        },
    });
});
