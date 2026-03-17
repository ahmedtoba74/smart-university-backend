import express from "express";
import * as departmentController from "./departmentController.js";
import {
    protect,
    restrictTo,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import userRouter from "../users/userRouter.js";

const router = express.Router({ mergeParams: true });

// All department routes require authentication + admin role + college scope
router.use(protect);
router.use(restrictTo("universityAdmin", "collegeAdmin"));
router.use(attachCollegeScope);

// ─── Nested Route ──────────────────────────────────────────────────────────
router.use("/:departmentId/users", userRouter);

// ─── CRUD ──────────────────────────────────────────────────────────────────
router
    .route("/")
    .get(departmentController.getAllDepartments)
    .post(departmentController.createDepartment);

router
    .route("/:id")
    .get(departmentController.getDepartment)
    .patch(departmentController.updateDepartment);

// ─── Archive / Restore ─────────────────────────────────────────────────────
// [SECURITY] Archive/Restore is restricted to universityAdmin only — collegeAdmin cannot archive/restore
router.patch(
    "/:id/archive",
    restrictTo("universityAdmin"),
    departmentController.archiveDepartment,
);
router.patch(
    "/:id/restore",
    restrictTo("universityAdmin"),
    departmentController.restoreDepartment,
);

export default router;
