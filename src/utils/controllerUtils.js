/**
 * ===================================================================================
 * @file      controllerUtils.js
 * @desc      Generic helper functions for standard REST API controller responses.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/Controller
 */

import mongoose from "mongoose";
import AppError from "./appError.js";

// ============================================
// SHARED CONTROLLER UTILITIES
// ============================================

/**
 * Protected fields that can never be selected via ?fields query param.
 * Even though these fields have `select: false` in the model, we block them
 * proactively to prevent information about their existence leaking.
 */
const PROTECTED_FIELDS = [
    "password",
    "tempPassword",
    "nationalID",
    "nationalIDHash",
    "passwordResetToken",
    "passwordResetExpires",
    "twoFAToken",
    "twoFATokenExpires",
];

/**
 * Validates and normalizes the `?isArchived` query parameter.
 *
 * Security: prevents NoSQL injection via ?isArchived[$ne]=true.
 * Access:   non-admin roles always see active items only.
 * Values:   'true' → archived only | 'false' → active only | 'all' → both
 *
 * Returns false and calls next(error) if invalid.
 * Returns true if the guard passes (caller should continue).
 *
 * @param {Object} req   - Express request object
 * @param {Function} next - Express next function
 * @returns {boolean}
 */
export const applyIsArchivedGuard = (req, next) => {
    const VALID_VALUES = ["true", "false", "all"];
    const raw = req.query.isArchived;

    if (raw === undefined) {
        req.archivedFilter = {}; // pre-hook handles default (active only)
        return true;
    }

    // Reject objects: ?isArchived[$ne]=true arrives as an object, not a string
    if (typeof raw !== "string" || !VALID_VALUES.includes(raw)) {
        next(
            new AppError(
                "Invalid value for isArchived. Allowed: true, false, all.",
                400,
            ),
        );
        return false;
    }

    const isAdminRole = ["universityAdmin", "collegeAdmin"].includes(
        req.user.role,
    );

    if (!isAdminRole) {
        // Non-admins always see active items — strip the param entirely
        delete req.query.isArchived;
        req.archivedFilter = {};
    } else if (raw === "all") {
        // Delete from query so apiFeatures.filter() doesn't try to JSON-serialize it
        // Set archivedFilter for controllers to merge into the base query directly
        delete req.query.isArchived;
        req.archivedFilter = { isArchived: { $in: [true, false] } };
    } else if (raw === "true") {
        delete req.query.isArchived;
        req.archivedFilter = { isArchived: true };
    } else {
        // 'false' — explicit, same as default
        delete req.query.isArchived;
        req.archivedFilter = { isArchived: false };
    }

    return true;
};

/**
 * Blocks attempts to select sensitive fields via ?fields query param.
 *
 * Security: even though protected fields have `select: false` in the model,
 * this defense-in-depth check prevents probing for field existence.
 *
 * Returns false and calls next(error) if blocked.
 * Returns true if the guard passes.
 *
 * @param {Object} req   - Express request object
 * @param {Function} next - Express next function
 * @returns {boolean}
 */
export const applyFieldsGuard = (req, next) => {
    if (!req.query.fields) return true;

    const requested = req.query.fields.split(",").map((f) => f.trim());
    const blocked = requested.filter((f) => PROTECTED_FIELDS.includes(f));

    if (blocked.length > 0) {
        next(
            new AppError(
                `Access to protected fields is not allowed: ${blocked.join(", ")}.`,
                403,
            ),
        );
        return false;
    }

    return true;
};

/**
 * Builds a filtered request body from an explicit whitelist.
 *
 * Security: Whitelist approach — only explicitly allowed fields are
 * passed to the database. Prevents mass-assignment of sensitive fields
 * like isArchived, college_id, role, etc.
 *
 * @param {Object} body          - req.body
 * @param {string[]} allowedFields - array of field names to permit
 * @returns {Object} filteredBody — only contains keys in allowedFields
 */
export const filterReqBody = (body, allowedFields) => {
    const filteredBody = {};
    allowedFields.forEach((field) => {
        if (body[field] !== undefined) {
            filteredBody[field] = body[field];
        }
    });
    return filteredBody;
};

/**
 * Builds the ownership-aware filter for scoped write operations (PATCH, archive).
 *
 * Security: Bakes the ownership check directly into the DB query (TOCTOU fix).
 * If a collegeAdmin passes a resource ID from another college, MongoDB returns
 * null — the controller returns 404, preventing info leakage.
 *
 * @param {string} id      - req.params.id
 * @param {Object} user    - req.user
 * @param {string} scopeField - the field to scope by (default: 'college_id')
 * @returns {Object} MongoDB filter
 */
export const buildOwnershipFilter = (
    param,
    user,
    scopeField = "college_id",
    slugField = "slug",
) => {
    const filter = buildIdOrSlugFilter(param, slugField);
    if (user.role === "collegeAdmin") {
        filter[scopeField] = user.college_id;
    }
    return filter;
};

// ============================================
// SLUG UTILITIES
// ============================================

/**
 * Builds a MongoDB filter that supports both ObjectId and slug lookup.
 * If param is a valid 24-char hex ObjectId → filter by _id.
 * Otherwise → filter by the slug field (slug, code, etc.).
 *
 * @param {string} param - req.params.id (either ObjectId string or slug)
 * @param {string} slugField - field name to match against (default: 'slug')
 * @returns {Object} MongoDB filter: { _id } | { [slugField] }
 */
export const buildIdOrSlugFilter = (param, slugField = "slug") => {
    return mongoose.Types.ObjectId.isValid(param)
        ? { _id: param }
        : { [slugField]: param };
};

// ============================================
// NESTED ROUTE MIDDLEWARE
// ============================================

/**
 * Middleware for nested college routes (e.g. GET /colleges/:id/departments).
 * Resolves the college from :id (ObjectId or slug), then sets req.scopeFilter
 * so that the downstream department/location controller is automatically scoped.
 *
 * Usage in collegeRouter:
 *   router.get('/:id/departments', restrictTo('universityAdmin'), resolveCollegeParam, getAllDepartments);
 */
export const resolveCollegeParam = async (req, res, next) => {
    try {
        // Lazy import to avoid circular dependency at module load time
        const { default: College } =
            await import("../../DB/models/collegeModel.js");

        const filter = buildIdOrSlugFilter(req.params.id);
        const college = await College.findOne(filter).select("_id");

        if (!college) return next(new AppError("College not found.", 404));

        // Override scopeFilter — downstream controllers use this for all queries
        req.scopeFilter = { college_id: college._id };
        next();
    } catch (err) {
        next(err);
    }
};
