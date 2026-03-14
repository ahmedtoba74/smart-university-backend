import mongoose from "mongoose";

const collegeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "College name is required"],
        unique: true,
        trim: true
    },
    code: {
        type: String,
        required: [true, "College code is required"],
        unique: true,
        uppercase: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    dean_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    establishedYear: {
        type: Number
    },
    /**
     * Uni-directional relationship: College does NOT store department IDs.
     * Departments are fetched via: Department.find({ college_id: collegeId })
     * This avoids array sync issues and keeps a single source of truth.
     */
    isArchived: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// ============================================
// QUERY MIDDLEWARE
// ============================================

/**
 * Automatically excludes archived colleges from all queries.
 * Uses array syntax to cover countDocuments (fixes pagination totals).
 * To bypass: explicitly set isArchived in the filter, e.g. { isArchived: true }.
 */
collegeSchema.pre(
    ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'countDocuments'],
    function () {
        if (this.getFilter().isArchived === undefined) {
            this.where({ isArchived: false });
        }
    }
);

const College = mongoose.model("College", collegeSchema);
export default College;
