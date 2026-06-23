/**
 * ===================================================================================
 * @file      materialModel.js
 * @desc      Mongoose schema and model definition for course Materials, including slides, links, and documents.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/Material
 */

import mongoose from "mongoose";

/**
 * @fileoverview Material Model - Manages course learning materials and resources.
 * Supports file uploads (Cloudinary) and external links across four categories:
 * Lectures, Sheets (problem sets), Readings, and Links.
 *
 * @module models/Material
 * @requires mongoose
 *
 * @description
 * Key Features:
 * - Four material categories (Lectures, Sheets, Readings, Links)
 * - Dual storage: File uploads (Cloudinary) + External URLs
 * - Ownership tracking (uploadedBy_id) for edit/delete permissions
 * - Tenant isolation via college_id (IDOR protection)
 * - Scoped to specific course offerings
 *
 * @audit
 * - GAP-3: college_id for tenant isolation (req.scopeFilter pattern)
 */

/**
 * Material Schema Definition
 *
 * @typedef {Object} Material
 * @property {string} title - Material title (required, trimmed)
 * @property {string} description - Optional description of the material
 * @property {ObjectId} courseOffering_id - Reference to CourseOffering (required, indexed)
 * @property {ObjectId} college_id - Denormalized for tenant isolation (required, indexed)
 * @property {string} category - Material category (Lectures|Sheets|Readings|Links)
 * @property {boolean} isExternalLink - Whether material is external URL vs uploaded file
 * @property {string} url - File URL (Cloudinary) or external link (required)
 * @property {string} fileName - Original filename for uploaded files
 * @property {string} fileType - MIME type for uploaded files
 * @property {ObjectId} uploadedBy_id - Reference to User who created/uploaded (required)
 * @property {Date} createdAt - Auto-generated timestamp
 * @property {Date} updatedAt - Auto-generated timestamp
 */

const materialSchema = new mongoose.Schema(
    {
        /**
         * Material title
         * Displayed in course materials list
         *
         * @type {string}
         * @required
         * @example "Lecture 3 - Sorting Algorithms"
         */
        title: {
            type: String,
            required: [true, "Title is required"],
            trim: true,
        },

        /**
         * Optional detailed description of the material
         * Can include context, reading instructions, or prerequisites
         *
         * @type {string}
         * @example "Review bubble sort and merge sort before watching"
         */
        description: {
            type: String,
            trim: true,
        },

        /**
         * Reference to the CourseOffering this material belongs to
         * All materials are scoped to a specific course offering (semester instance)
         *
         * @type {ObjectId}
         * @ref CourseOffering
         * @required
         * @indexed
         */
        courseOffering_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CourseOffering",
            required: [true, "Course Offering ID is required"],
            index: true,
        },

        /**
         * Denormalized college_id for tenant isolation (IDOR protection)
         * Denormalized from CourseOffering → college_id
         * Enables req.scopeFilter tenant isolation pattern from Phase 3
         * Set automatically by controller via courseOffering.college_id lookup
         * Never accepted from request body
         *
         * @type {ObjectId}
         * @ref College
         * @required
         * @indexed
         * @audit GAP-3 - Tenant isolation for materials
         *
         * @note Required for college-scoped queries and admin access control
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College ID is required"],
            index: true,
        },

        /**
         * Material category for organizational grouping
         * Frontend uses this to display materials in separate tabs/sections
         *
         * Lectures: Video recordings, slides, presentation files
         * Sheets: Problem sets, practice exercises, worksheets
         * Readings: Textbook chapters, articles, supplementary documents
         * Links: External resources, videos, interactive tools
         *
         * @type {string}
         * @required
         * @enum ['Lectures', 'Sheets', 'Readings', 'Links']
         */
        category: {
            type: String,
            enum: ["Lectures", "Sheets", "Readings", "Links"],
            required: true,
        },

        /**
         * Determines if material is external URL vs uploaded file
         *
         * true: url field contains external link (YouTube, Google Drive, etc.)
         * false: url field contains Cloudinary upload URL
         *
         * @type {boolean}
         * @default false
         */
        isExternalLink: {
            type: Boolean,
            default: false,
        },

        /**
         * Material URL
         * - If isExternalLink=true: External URL (e.g., https://youtube.com/...)
         * - If isExternalLink=false: Cloudinary upload URL
         *
         * @type {string}
         * @required
         * @example "https://res.cloudinary.com/.../lecture3.pdf"
         */
        url: {
            type: String,
            required: [true, "URL is required"],
        },

        /**
         * Original filename (for uploaded files only)
         * Displayed to users for download clarity
         * Empty for external links
         *
         * @type {string}
         * @example "lecture_03_sorting.pdf"
         */
        fileName: String,

        /**
         * MIME type (for uploaded files only)
         * Used for icon display and download behavior
         * Empty for external links
         *
         * @type {string}
         * @example "application/pdf"
         */
        fileType: String,

        /**
         * Reference to the User (doctor/TA) who uploaded/created this material
         * Used for permission checks (edit/delete restricted to uploader + doctors)
         *
         * @type {ObjectId}
         * @ref User
         * @required
         *
         * @note TAs can only edit/delete their own materials
         * @note Doctors can edit/delete any material in their course
         */
        uploadedBy_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
    },
    {
        timestamps: true,
    },
);

// ===========================================
// MODEL EXPORT
// ===========================================

/**
 * Material Model
 * @type {mongoose.Model<Material>}
 */
const Material = mongoose.model("Material", materialSchema);
export default Material;
