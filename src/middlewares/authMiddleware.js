import { promisify } from "util";
import jwt from "jsonwebtoken";
import User from "../../DB/models/userModel.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";

// ==============================
// 1. Authentication Middleware
// ==============================

/**
 * Verifies the JWT token and attaches the authenticated user to req.user.
 * Also enforces:
 *  - Single-session: blocks old tokens when a newer login exists.
 *  - Password rotation: blocks tokens issued before a password change.
 *  - Temporary password: forces the user to update before any other action.
 */
export const protect = catchAsync(async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies && req.cookies.jwt) {
        token = req.cookies.jwt;
    }

    if (!token) {
        return next(
            new AppError(
                "You are not logged in! Please log in to get access.",
                401,
            ),
        );
    }

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
        return next(
            new AppError(
                "The user belonging to this token no longer exists.",
                401,
            ),
        );
    }

    // Single-session guard: a newer login invalidates all older tokens
    if (currentUser.lastLoginAt) {
        const lastLoginTimestamp = parseInt(
            currentUser.lastLoginAt.getTime() / 1000,
            10,
        );
        if (lastLoginTimestamp > decoded.iat) {
            return next(
                new AppError(
                    "User recently logged in from another device. Please log in again.",
                    401,
                ),
            );
        }
    }

    // Password rotation guard: token issued before password change is invalid
    if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next(
            new AppError(
                "User recently changed password! Please log in again.",
                401,
            ),
        );
    }

    /**
     * Invalidation Timestamp Guard (Phase 2):
     * Immediately terminates sessions blocked via admin or self-update.
     * Compares the JWT's issued-at time (iat) against `tokensInvalidatedAt`.
     * Using `<=` (not `<`) ensures cryptographic safety and naturally handles clock drift.
     */
    if (currentUser.tokensInvalidatedAt) {
        const invalidationTimestamp = parseInt(
            currentUser.tokensInvalidatedAt.getTime() / 1000,
            10,
        );
        // Using <= (not <) — cryptographically safe, handles clock drift natively
        if (decoded.iat <= invalidationTimestamp) {
            return next(
                new AppError(
                    "Your session was terminated. Please log in again.",
                    401,
                ),
            );
        }
    }

    req.user = currentUser;
    res.locals.user = currentUser;
    next();
});

// ==============================
// 2. Authorization Middleware
// ==============================

/**
 * Restricts access to users whose role is in the provided list.
 * Must be used after `protect`.
 * @param  {...string} roles - Allowed roles.
 */
export const restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(
                new AppError(
                    "You do not have permission to perform this action",
                    403,
                ),
            );
        }
        next();
    };
};

// ==============================
// 3. College Scope Middleware
// ==============================

/**
 * Hybrid Scoping: Injects `req.scopeFilter` based on the user's role.
 *
 * - universityAdmin : no filter → sees everything
 * - collegeAdmin    : scoped to their own college_id
 * - other roles     : impossible filter → returns nothing (safety net)
 *
 * Usage: place after `protect` on any admin router.
 * Controllers use `req.scopeFilter` directly in READ queries.
 * WRITE operations must additionally perform an ownership check.
 */
export const attachCollegeScope = (req, res, next) => {
    if (req.user.role === "universityAdmin") {
        req.scopeFilter = {};
        return next();
    }

    // Support for all college-bound roles defined in Phase 3 Plan
    if (["collegeAdmin", "doctor", "ta", "student"].includes(req.user.role)) {
        if (!req.user.college_id) {
            return next(
                new AppError(
                    "Your account is not linked to any college. Please contact the system administrator.",
                    403,
                ),
            );
        }
        req.scopeFilter = { college_id: req.user.college_id };
        return next();
    }

    // Safety net: any other role that somehow reaches an admin route
    req.scopeFilter = { _id: null };
    next();
};

// ==============================
// 4. Staff Scope Middleware
// ==============================

/**
 * Injects `req.staffFilter` based on the user's teaching role.
 *
 * - doctor : only sees offerings where they are in doctors_ids
 * - ta     : only sees offerings where they are in tas_ids
 * - other  : no filter → sees everything (relies on attachCollegeScope for security)
 *
 * Used primarily for GET /course-offerings list endpoint.
 */
export const attachStaffScope = (req, res, next) => {
    if (req.user.role === "doctor") {
        req.staffFilter = { doctors_ids: req.user._id };
        return next();
    }
    if (req.user.role === "ta") {
        req.staffFilter = { tas_ids: req.user._id };
        return next();
    }

    req.staffFilter = {};
    next();
};
