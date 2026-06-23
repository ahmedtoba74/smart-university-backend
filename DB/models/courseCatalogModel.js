/**
 * ===================================================================================
 * @file      courseCatalogModel.js
 * @desc      Mongoose schema and model definition for the Course Catalog, storing static course details, pre-requisites, and credits.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/CourseCatalog
 */

import mongoose from "mongoose";

const courseCatalogSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, "Course title is required"],
            trim: true,
        },
        code: {
            type: String,
            required: [true, "Course code is required"],
            unique: true,
            lowercase: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        creditHours: {
            type: Number,
            required: [true, "Credit hours are required"],
            min: [1, "Credit hours must be at least 1"],
        },
        prerequisites_ids: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "CourseCatalog",
            },
        ],
        department_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Department",
            required: [true, "Department is required"],
        },
        /**
         * @field college_id - Denormalized from department.college_id for fast scoping.
         * Set automatically by the controller when creating a course.
         * Allows a single-query filter: CourseCatalog.find({ college_id }) for collegeAdmin.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            required: [true, "College is required"],
            index: true,
        },
        isArchived: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true },
);

// ===========================================
// QUERY MIDDLEWARE — Phase 1 isArchived Pattern
// ===========================================

/**
 * Pre-find hook: Auto-filter archived courses from all queries.
 * Covers: find, findOne, findOneAndUpdate, findOneAndDelete, countDocuments.
 * To include archived documents, pass { isArchived: true } or { isArchived: { $in: [true, false] } }
 * explicitly in the filter.
 */
courseCatalogSchema.pre(
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

const CourseCatalog = mongoose.model("CourseCatalog", courseCatalogSchema);
export default CourseCatalog;
