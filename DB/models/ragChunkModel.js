/**
 * ===================================================================================
 * @file      ragChunkModel.js
 * @desc      Mongoose model for RAG (Retrieval-Augmented Generation) text chunks.
 *            Each document holds one chunk of a user-uploaded file along with its
 *            Azure embedding vector. Lifecycle is conversation-bound — chunks are
 *            deleted via cascade when the parent conversation is deleted.
 *            NO TTL index: time-based expiry would break RAG mid-conversation.
 *            The vector search index must be created manually in MongoDB Atlas.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/models/ragChunkModel
 */

/**
 * IMPORTANT: The vector search index on the `embedding` field must be created
 * manually in MongoDB Atlas with the following configuration:
 * {
 *   "name": "chat_rag_vector_index",
 *   "type": "vectorSearch",
 *   "definition": {
 *     "fields": [
 *       { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
 *       { "type": "filter", "path": "conversation_id" },
 *       { "type": "filter", "path": "user_id" }
 *     ]
 *   }
 * }
 * numDimensions must match the Azure embedding deployment (1536 for text-embedding-3-small).
 * user_id is a required filter path for defense-in-depth RAG isolation (see §10 plan).
 */

import mongoose from "mongoose";

const ragChunkSchema = new mongoose.Schema(
    {
        /**
         * Parent Conversation. RAG chunks are cascade-deleted when this is deleted.
         */
        conversation_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
            index: true,
        },
        /**
         * The User who uploaded the file.
         * Filtered in vector search for defense-in-depth security.
         */
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        /**
         * The Message document that this chunk belongs to.
         * Initially null because uploads occur before message persistence.
         */
        message_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Message",
            default: null,
        },
        /**
         * Raw text content of the chunk.
         */
        content: {
            type: String,
            required: true,
        },
        /**
         * Vector representation of the text chunk.
         * Default deployment is 1536 dimensions (text-embedding-3-small).
         */
        embedding: {
            type: [Number],
            required: true,
        },
        /**
         * Position of the chunk inside the original file.
         * Used to reconstruct reading order if multiple chunks are retrieved.
         */
        chunkIndex: {
            type: Number,
            required: true,
        },
        /**
         * Original name of the uploaded document (e.g. "lecture1.pdf").
         */
        fileName: {
            type: String,
            required: true,
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
    },
);

// Indexes
ragChunkSchema.index({ conversation_id: 1 });
ragChunkSchema.index({ college_id: 1 }, { sparse: true });

const RagChunk = mongoose.model("RagChunk", ragChunkSchema);
export default RagChunk;
