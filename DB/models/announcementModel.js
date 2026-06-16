import mongoose from "mongoose";

const announcementSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, "Title is required"],
            trim: true,
            maxlength: [200, "Title cannot exceed 200 characters"],
        },
        content: {
            type: String,
            required: [true, "Content is required"],
            maxlength: [5000, "Content cannot exceed 5000 characters"],
        },
        author_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Author is required"],
            index: true,
        },
        scope: {
            level: {
                type: String,
                enum: ["Global", "Course", "Department", "College"],
                required: [true, "Scope level is required"],
                index: true,
            },
            target: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    // Contents depend on scope.level:
                    // - "Global"     -> always empty array []
                    // - "College"    -> [college_id]
                    // - "Department" -> [dept_id, ...]
                    // - "Course"     -> [courseOfferingId, ...]
                    // Validated in pre-save hook below.
                },
            ],
        },
        isArchived: {
            type: Boolean,
            default: false,
            index: true,
        },
        // Optional auto-expiry date. When set, the hourly cleanup job in server.js
        // soft-deletes this announcement once the timestamp passes.
        // Must be a future date at creation time (validated in the controller).
        expiresAt: {
            type: Date,
            default: null,
            index: true, // Indexed for efficient $lte cleanup queries
        },
    },
    { timestamps: true },
);

// ===========================================
// INDEXES
// ===========================================

// Primary visibility query: filter by scope level and archive status
announcementSchema.index({ "scope.level": 1, isArchived: 1, createdAt: -1 });

// Scoped visibility query: filter by scope level + specific target IDs
announcementSchema.index({
    "scope.level": 1,
    "scope.target": 1,
    isArchived: 1,
    createdAt: -1,
});

// ===========================================
// DOCUMENT MIDDLEWARE — Pre-Save Hook
// ===========================================

/**
 * Enforce scope.target array size constraints based on scope.level.
 * - Global announcements must have an empty target array.
 * - All other scope levels must have at least one target.
 * Controller deduplicates and validates target content before save.
 */
announcementSchema.pre("save", function () {
    if (
        this.scope.level === "Global" &&
        this.scope.target &&
        this.scope.target.length > 0
    ) {
        this.invalidate(
            "scope.target",
            "Global announcements must have an empty target array.",
        );
    }
    if (
        this.scope.level !== "Global" &&
        (!this.scope.target || this.scope.target.length === 0)
    ) {
        this.invalidate(
            "scope.target",
            "Non-global announcements must specify at least one target.",
        );
    }
});

// ===========================================
// QUERY MIDDLEWARE — Pre-Find Hook
// ===========================================

/**
 * Auto-filter archived announcements from all standard queries.
 * Pattern matches courseOfferingModel.js and departmentModel.js.
 * To bypass: include isArchived explicitly in the filter, e.g.:
 *   { isArchived: { $in: [true, false] } }
 */
announcementSchema.pre(
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

const Announcement = mongoose.model("Announcement", announcementSchema);
export default Announcement;
