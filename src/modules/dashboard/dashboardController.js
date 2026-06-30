/**
 * ===================================================================================
 * @file      dashboardController.js
 * @desc      Controller for GET /api/v1/dashboard/summary.
 *            Reads the caller's role from req.user (injected by protect middleware)
 *            and delegates to the appropriate service payload builder.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Dashboard/Controller
 */

import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import {
    buildAdminPayload,
    buildDoctorPayload,
    buildStudentPayload,
} from "./dashboardService.js";

/**
 * GET /api/v1/dashboard/summary
 *
 * Role-dispatching controller. The frontend never sends a role parameter —
 * the role is read exclusively from req.user set by the protect middleware.
 *
 * Response envelope matches the frontend contract:
 *   { "status": "success", "data": { ...rolePayload } }
 *
 * The client also accepts a bare { ...payload } (no envelope) per dashboard.service.ts,
 * but we always return the standard envelope for consistency.
 *
 * Supported roles:
 *   - universityAdmin, collegeAdmin → admin payload (§1)
 *   - doctor, ta                   → doctor/TA payload (§2)
 *   - student                      → student payload (§3)
 */
export const getSummary = catchAsync(async (req, res, next) => {
    const { role } = req.user;

    let payload;

    if (role === "universityAdmin" || role === "collegeAdmin") {
        payload = await buildAdminPayload(req.user);
    } else if (role === "doctor" || role === "ta") {
        payload = await buildDoctorPayload(req.user);
    } else if (role === "student") {
        payload = await buildStudentPayload(req.user);
    } else {
        return next(
            new AppError(
                "Dashboard summary is not available for your role.",
                403,
            ),
        );
    }

    res.status(200).json({
        status: "success",
        data: payload,
    });
});
