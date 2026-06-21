/**
 * ===================================================================================
 * @file      ragTools.js
 * @desc      RAG retrieval tool — available to all authenticated roles.
 *            Loaded when conversation.hasRagContext === true.
 *
 *            searchDocuments performs a vector similarity search against uploaded
 *            RAG chunks for the current conversation. The search filter includes
 *            both conversation_id and user_id as defense-in-depth to ensure no
 *            cross-user data is ever returned even if the conversation ownership
 *            check were accidentally bypassed.
 *
 *            Note: This tool is wired by the agent at construction time with the
 *            conversationId injected into userContext when hasRagContext is true.
 *            The agent will pass ragContext directly to the system prompt rather
 *            than calling this tool explicitly in most cases — this tool exists
 *            so the agent can re-query the document when the user asks follow-up
 *            questions about their uploaded file.
 *
 * @module    src/tools/registry/ragTools
 * @requires  zod
 * @requires  ../../../DB/models/ragChunkModel
 * ===================================================================================
 */

import { z } from "zod";
import RagChunk from "../../../DB/models/ragChunkModel.js";

// ===================================================================================
// TOOL: searchDocuments
// ===================================================================================

/**
 * Performs a vector similarity search over uploaded RAG chunks for the current
 * conversation. Returns the top-K most relevant chunks ranked by semantic similarity.
 *
 * SECURITY: The filter always includes user_id as defense-in-depth. Even if
 * conversation ownership were accidentally bypassed upstream, this ensures no
 * chunk belonging to a different user can be returned.
 *
 * Note: This tool requires a queryEmbedding computed from the user's query text.
 * The chatService computes embeddings for the initial RAG context injection; this
 * tool is used for follow-up questions where the agent decides to re-query the document.
 */
const searchDocuments = {
    name: "searchDocuments",
    label: "Searched your uploaded document",
    description:
        "Searches the uploaded document for information relevant to the user's question. Use this tool when the user references their uploaded document or asks a question that can be answered from the document content.",
    schema: z.object({
        query: z
            .string()
            .min(1)
            .describe(
                "The search query to find relevant content in the uploaded document.",
            ),
    }),
    execute: async (input, userContext) => {
        if (!userContext.conversationId) {
            return JSON.stringify({
                error: "No conversation context available for document search.",
            });
        }

        // Reuse the embedding model singleton from chatService.
        // Dynamic import is used here to avoid a load-time circular dependency:
        // chatService.js -> chatTools.js -> ragTools.js -> chatService.js.
        const { embeddingModel } =
            await import("../../services/chatService.js");
        const queryEmbedding = await embeddingModel.embedQuery(input.query);

        // Vector search with defense-in-depth user_id filter
        const results = await RagChunk.aggregate([
            {
                $vectorSearch: {
                    index: "chat_rag_vector_index",
                    path: "embedding",
                    queryVector: queryEmbedding,
                    numCandidates: 50,
                    limit: 5,
                    filter: {
                        conversation_id: userContext.conversationId,
                        user_id: userContext.user._id,
                    },
                },
            },
            {
                $project: {
                    content: 1,
                    fileName: 1,
                    chunkIndex: 1,
                    score: { $meta: "vectorSearchScore" },
                },
            },
        ]);

        if (!results.length) {
            return JSON.stringify({
                message: "No relevant content found in the uploaded document.",
                chunks: [],
            });
        }

        // Sort by chunkIndex to restore reading order for context coherence
        const sorted = results.sort((a, b) => a.chunkIndex - b.chunkIndex);
        const contextText = sorted
            .map((r) => `[From: ${r.fileName}]\n${r.content}`)
            .join("\n\n---\n\n");

        return JSON.stringify({
            chunksFound: results.length,
            context: contextText,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [searchDocuments];
