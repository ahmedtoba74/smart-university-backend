import mongoose from "mongoose";

const collegeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "College name is required"],
            unique: true,
            trim: true,
        },
        /**
         * @field slug - URL-friendly identifier derived from name.
         * Auto-generated on save. Used in frontend routes: /colleges/college-of-engineering
         */
        slug: {
            type: String,
            unique: true,
            lowercase: true,
            trim: true,
        },
        code: {
            type: String,
            required: [true, "College code is required"],
            unique: true,
            uppercase: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        dean_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
        establishedYear: {
            type: Number,
            min: 1900,
            max: new Date().getFullYear(),
        },
        /**
         * Uni-directional relationship: College does NOT store department IDs.
         * Departments are fetched via: Department.find({ college_id: collegeId })
         * This avoids array sync issues and keeps a single source of truth.
         */
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
collegeSchema.pre("save", function () {
    if (this.isModified("name") || this.isNew) {
        this.slug = generateSlug(this.name);
    }
});

/** Keep slug in sync when name is updated via findOneAndUpdate / findByIdAndUpdate */
collegeSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function () {
    const update = this.getUpdate();
    const name = update?.name ?? update?.$set?.name;
    if (name) this.set({ slug: generateSlug(name) });
});

// ============================================
// QUERY MIDDLEWARE
// ============================================

/**
 * Automatically excludes archived colleges from all queries.
 * Uses array syntax to cover countDocuments (fixes pagination totals).
 * To bypass: explicitly set isArchived in the filter, e.g. { isArchived: true }.
 */
collegeSchema.pre(
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

const College = mongoose.model("College", collegeSchema);
export default College;
