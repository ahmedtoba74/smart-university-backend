/**
 * ===================================================================================
 * @file      collegeParamGuard.js
 * @desc      Middleware to securely lock college Admins to their scope in nested routes
 *            and prevent IDOR via 404 responses.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Middlewares/CollegeGuard
 */
import AppError from "../utils/appError.js";

/**
 * Validates that the requested collegeId in URL matches the collegeAdmin's college_id.
 * Bypassed for universityAdmins. Returns 404 to prevent enumeration.
 * @function collegeParamGuard
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const collegeParamGuard = (req, res, next) => {
    // Only applies to collegeAdmin — universityAdmin passes freely
    if (req.user && req.user.role === "collegeAdmin") {
        if (
            req.params.collegeId &&
            req.params.collegeId !== req.user.college_id.toString()
        ) {
            // 404 not 403 — prevents college ID enumeration attacks (IDOR prevention)
            return next(new AppError("Not found.", 404));
        }
    }
    next();
};
