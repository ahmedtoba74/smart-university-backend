/**
 * ===================================================================================
 * @file      bulkImportLogModel.js
 * @desc      Mongoose model for tracking bulk import operations. Enables asynchronous
 *            credentials resending, error tracking, and AES-encrypted temporary passwords.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/BulkImportLog
 */
import mongoose from "mongoose";

const bulkImportLogSchema = new mongoose.Schema({
    importedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    college_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "College",
        required: true,
    },
    importedAt: { type: Date, default: Date.now },
    totalRows: { type: Number, required: true },
    created: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    records: [
        {
            row: { type: Number },
            name: { type: String },
            email: { type: String },
            nationalID: { type: String },
            userId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                default: null,
            },
            tempPassword: { type: String }, // AES-256 encrypted using cryptoUtils
            status: {
                type: String,
                enum: ["created", "failed", "invalidated"],
                required: true,
            },
            failReason: { type: String, default: null },
            emailSent: { type: Boolean, default: false },
        },
    ],
    // TTL: auto-delete document after 30 days
    expireAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        index: { expireAfterSeconds: 0 },
    },
});

export default mongoose.model("BulkImportLog", bulkImportLogSchema);
