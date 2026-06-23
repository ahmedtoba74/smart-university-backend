/**
 * ===================================================================================
 * @file      enforcePasswordChange.js
 * @desc      Globally applied middleware to reject requests from users needing to
 *            update temporary passwords, maintaining an open emergency exit (Logout).
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Middlewares/EnforcePasswordChange
 */
import AppError from "../utils/appError.js";

// ── Exact-match whitelist (never use .includes() on URL string — path traversal risk)
const PASSWORD_CHANGE_WHITELIST = [
    "/api/v1/auth/updatePassword", // Step 1: request OTP to initiate password change
    "/api/v1/auth/updatePassword/confirm", // Step 2: confirm with OTP + new password (actual change happens here)
    "/api/v1/auth/logout", // Emergency exit — prevents Hostage Bug
];

/**
 * Blocks authenticated users who have `requiresPasswordChange` set to true
 * from accessing any endpoints other than the whitelisted ones.
 * @function enforcePasswordChange
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const enforcePasswordChange = (req, res, next) => {
    if (
        req.user?.requiresPasswordChange === true &&
        // Strip query string before matching to handle e.g. /logout?redirect=home
        !PASSWORD_CHANGE_WHITELIST.includes(req.originalUrl.split("?")[0])
    ) {
        return next(
            new AppError(
                "You must change your temporary password before accessing any feature.",
                403,
            ),
        );
    }
    next();
};
