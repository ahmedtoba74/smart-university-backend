/**
 * ===================================================================================
 * @file      locationModel.js
 * @desc      Mongoose schema and model definition for Locations, describing classrooms, halls, and capacity ceilings.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/Location
 */

import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Location name is required"],
            trim: true,
        },
        /**
         * @field slug - URL-friendly identifier derived from name.
         * Unique within the same college (compound index: college_id + slug).
         * Used in frontend routes: /colleges/:slug/locations/hall-a
         */
        slug: {
            type: String,
            lowercase: true,
            trim: true,
        },
        /**
         * @field college_id - Scopes the location to a specific college.
         * CollegeAdmin can only manage locations in their own college.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College is required"],
            index: true,
        },
        building: {
            type: String,
            trim: true,
        },
        floor: {
            type: Number,
        },
        roomNumber: {
            type: String,
            trim: true,
        },
        capacity: {
            type: Number,
            required: [true, "Capacity is required"],
            min: [1, "Capacity must be at least 1"],
        },
        type: {
            type: String,
            enum: ["lecture_hall", "lab", "section_room", "auditorium"],
            required: [true, "Location type is required"],
        },
        /**
         * @field status - Controls whether the room is available for scheduling.
         * CollegeAdmin can set to 'maintenance' to block fingerprint attendance and scheduling.
         */
        status: {
            type: String,
            enum: ["active", "maintenance"],
            default: "active",
        },
        /**
         * @field readerId - IoT Fingerprint Device ID bound to this room.
         * Used by the fingerprint attendance system to resolve which room a device belongs
         * to and which active session it should be marking attendance for.
         */
        readerId: {
            type: String,
            unique: true,
            sparse: true, // Rooms under maintenance may temporarily have no reader
            index: true,
            trim: true,
        },
        isArchived: {
            type: Boolean,
            default: false,
        },
        archivedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true },
);

// Compound unique index: slug is unique within a college, not globally
locationSchema.index(
    { college_id: 1, slug: 1 },
    { unique: true, sparse: true },
);

// ============================================
// HELPERS
// ============================================

const generateSlug = (text) =>
    text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

// ============================================
// DOCUMENT MIDDLEWARE
// ============================================

/** Auto-generate slug when name is set or changed */
locationSchema.pre("save", function () {
    if (this.isModified("name") || this.isNew) {
        this.slug = generateSlug(this.name);
    }
});

/** Keep slug in sync when name is updated via findOneAndUpdate / findByIdAndUpdate */
locationSchema.pre(
    ["findOneAndUpdate", "updateOne", "updateMany"],
    function () {
        const update = this.getUpdate();
        const name = update?.name ?? update?.$set?.name;
        if (name) this.set({ slug: generateSlug(name) });
    },
);

// ============================================
// QUERY MIDDLEWARE
// ============================================

/**
 * Automatically excludes archived locations from all queries.
 * Uses array syntax to cover countDocuments (fixes pagination totals).
 * To bypass: explicitly set isArchived in the filter, e.g. { isArchived: true }.
 */
locationSchema.pre(
    [
        "find",
        "findOne",
        "findOneAndUpdate",
        "findOneAndDelete",
        "countDocuments",
    ],
    function () {
        if (this.getFilter().isArchived === undefined) {
            this.where({ isArchived: false });
        }
    },
);

const Location = mongoose.model("Location", locationSchema);
export default Location;
