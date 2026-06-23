/**
 * ===================================================================================
 * @file      departmentModel.js
 * @desc      Mongoose schema and model definition for Departments, defining specific fields of study within colleges.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/Department
 */

import mongoose from "mongoose";

const departmentSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Department name is required"],
            trim: true,
        },
        code: {
            type: String,
            required: [true, "Department code is required"],
            unique: true,
            lowercase: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        head_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
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
        archivedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true },
);

// ============================================
// QUERY MIDDLEWARE
// ============================================

/**
 * Automatically excludes archived departments from all queries.
 * Uses array syntax to cover countDocuments (fixes pagination totals).
 * To bypass: explicitly set isArchived in the filter, e.g. { isArchived: true }.
 */
departmentSchema.pre(
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

const Department = mongoose.model("Department", departmentSchema);
export default Department;
