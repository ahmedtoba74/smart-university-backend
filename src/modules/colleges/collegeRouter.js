/**
 * ===================================================================================
 * @file      collegeRouter.js
 * @desc      Router defining API endpoints for Colleges.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Colleges/Router
 */

import express from "express";
import * as collegeController from "./collegeController.js";
import * as departmentController from "../departments/departmentController.js";
import * as locationController from "../locations/locationController.js";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";
import { resolveCollegeParam } from "../../utils/controllerUtils.js";
import departmentRouter from "../departments/departmentRouter.js";
import userRouter from "../users/userRouter.js";
import courseOfferingRouter from "../courseOfferings/courseOfferingRouter.js";

const router = express.Router();

// All college routes require authentication
router.use(protect);

// ─── Nested Route Mounts ──────────────────────────────────────────────────
router.use("/:collegeId/departments", departmentRouter);
router.use("/:collegeId/users", userRouter);
router.use("/:collegeId/course-offerings", courseOfferingRouter);

// ─── Flat CRUD (all authenticated roles for GET, UA for write) ─────────────
router
    .route("/")
    .get(collegeController.getAllColleges)
    .post(restrictTo("universityAdmin"), collegeController.createCollege);

router
    .route("/:id")
    .get(collegeController.getCollege)
    .patch(restrictTo("universityAdmin"), collegeController.updateCollege);

// ─── Archive / Restore (universityAdmin only) ─────────────────────────────
router.patch(
    "/:id/archive",
    restrictTo("universityAdmin"),
    collegeController.archiveCollege,
);
router.patch(
    "/:id/restore",
    restrictTo("universityAdmin"),
    collegeController.restoreCollege,
);

// ─── Nested: Departments of a College (universityAdmin only) ──────────────
// Resolves :id as college slug or ObjectId, then scopes downstream controller.

router.get(
    "/:id/departments",
    restrictTo("universityAdmin"),
    resolveCollegeParam,
    departmentController.getAllDepartments,
);

router.get(
    "/:id/departments/:deptId",
    restrictTo("universityAdmin"),
    resolveCollegeParam,
    // Remap :deptId → :id so getDepartment reads the correct param
    (req, _res, next) => {
        req.params.id = req.params.deptId;
        next();
    },
    departmentController.getDepartment,
);

// ─── Nested: Locations of a College (universityAdmin only) ────────────────

router.get(
    "/:id/locations",
    restrictTo("universityAdmin"),
    resolveCollegeParam,
    locationController.getAllLocations,
);

router.get(
    "/:id/locations/:locId",
    restrictTo("universityAdmin"),
    resolveCollegeParam,
    // Remap :locId → :id so getLocation reads the correct param
    (req, _res, next) => {
        req.params.id = req.params.locId;
        next();
    },
    locationController.getLocation,
);

export default router;
