/**
 * ===================================================================================
 * @project   Smart University Platform
 * @file      courseCatalogRouter.js
 * @desc      Express router for the Course Catalog module. Defines standard CRUD
 *            operations mapping strictly to the Phase 3 architecture guidelines.
 *            Enforces authentication, password rotation limits, and role-based
 *            access bounds uniquely tailored for `universityAdmin` and `collegeAdmin`.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 */
import express from "express";
import * as courseCatalogController from "./courseCatalogController.js";
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
 * ─── COLLECTION ROUTES ────────────────────────────────────────────────
 * Base: POST / | GET /
 * Roles: universityAdmin, collegeAdmin (scoped centrally via attachCollegeScope)
 */

router
    .route("/")
    .get(
        restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta", "student"),
        attachCollegeScope,
        courseCatalogController.getAllCourses,
    )
    .post(
        restrictTo("universityAdmin", "collegeAdmin"),
        attachCollegeScope,
        courseCatalogController.createCourse,
    );

/**
 * ─── DYNAMIC ROUTES ───────────────────────────────────────────────────
 * Base: GET /:id | PATCH /:id
 * Description: Scoped parameter updates and lookups leveraging `buildOwnershipFilter`.
 */

router
    .route("/:id")
    .get(
        restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta", "student"),
        attachCollegeScope,
        courseCatalogController.getCourse,
    )
    .patch(
        restrictTo("universityAdmin", "collegeAdmin"),
        attachCollegeScope,
        courseCatalogController.updateCourse,
    );

/**
 * ─── ARCHIVE ROUTES ───────────────────────────────────────────────────
 * Base: PATCH /:id/archive | PATCH /:id/restore
 * Description: Soft-deletion handlers protected by active offering collision guards.
 */

router.patch(
    "/:id/archive",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    courseCatalogController.archiveCourse,
);

router.patch(
    "/:id/restore",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    courseCatalogController.restoreCourse,
);

export default router;
