/**
 * ===================================================================================
 * @file      enrollmentRouter.js
 * @desc      Execution layer for the Enrollment Engine routes. Defines critical
 *            static priority architectures preventing Express hijacked routing
 *            over /force and /my endpoints. Implements strict Role Base validations.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Enrollments/Router
 */
import express from "express";
import * as enrollmentController from "./enrollmentController.js";
import {
    protect,
    restrictTo,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";

const router = express.Router();

// All routes require authentication and password rotation check
router.use(protect);
router.use(enforcePasswordChange);

/**
 * ─── STATIC ROUTES (Priority Required) ────────────────────────────────
 * Base: POST /force | GET /my
 * Desc: Must structurally precede dynamic /:id resolution engines.
 *       Handles Admin Overrides and self-scoped Student views uniquely.
 */

// POST /force - Admin override (Must precede /:id)
router.post(
    "/force",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    enrollmentController.forceEnrollStudent,
);

// GET /my - Student view own enrollments (Must precede /:id)
router.get("/my", restrictTo("student"), enrollmentController.getMyEnrollments);

/**
 * ─── COLLECTION ROUTES ────────────────────────────────────────────────
 * Base: GET / | POST /
 * Desc: Maps directly to Master Atomic transactional capacities explicitly
 *       bounding / to global queries or organic student capacity grabs.
 */

router
    .route("/")
    .get(
        restrictTo("universityAdmin", "collegeAdmin"),
        attachCollegeScope,
        enrollmentController.getAllEnrollments,
    )
    .post(restrictTo("student"), enrollmentController.enrollStudent);

/**
 * ─── DYNAMIC ROUTES ───────────────────────────────────────────────────
 * Base: GET /:id | PATCH /:id/withdraw
 * Desc: Enforces strict isolated parameter bounding ensuring constituents
 *       un-allocate capacities exactly linearly matching soft-deletion.
 */

router
    .route("/:id")
    .get(
        restrictTo(
            "universityAdmin",
            "collegeAdmin",
            "doctor",
            "ta",
            "student",
        ),
        attachCollegeScope,
        enrollmentController.getEnrollmentById,
    );

router.patch(
    "/:id/withdraw",
    restrictTo("universityAdmin", "collegeAdmin", "student"),
    attachCollegeScope,
    enrollmentController.withdrawStudent,
);

export default router;
