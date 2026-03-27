/**
 * ===================================================================================
 * @project   Smart University Platform
 * @file      userRouter.js
 * @desc      Express router for the Users module containing nested route structures,
 * strict ordering for static/dynamic routes, and parameter interceptors.
 * @author    Ahmed Toba <ahmed.toba.mahmoud@gmail.com>
 * @version   1.0.0
 * ===================================================================================
 */
import express from "express";
import * as userController from "./userController.js";
import {
    protect,
    restrictTo,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";
import { uploadMix } from "../../middlewares/uploadMiddleware.js";
import { fileValidation } from "../../utils/fileExtensions.js";

const router = express.Router({ mergeParams: true });

// ── Interceptor ───────────────────────────────────────────────────────
export const setNestedUserFilters = (req, res, next) => {
    if (req.params.collegeId) req.query.college_id = req.params.collegeId;
    if (req.params.departmentId)
        req.query.department_id = req.params.departmentId;
    next();
};
router.use(setNestedUserFilters);

// ── Multer Configuration ───────────────────────────────────────────────

import multer from "multer";

const bulkImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB hard cap
    fileFilter: (req, file, cb) => {
        const allowed = [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv",
            "application/vnd.ms-excel",
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else
            cb(
                new AppError("Only .xlsx and .csv files are accepted.", 400),
                false,
            );
    },
});

// ── STATIC ROUTES ─────────────────────────────────────────────────────

// GET /me
router.get(
    "/me",
    protect,
    enforcePasswordChange,
    userController.getMe,
    userController.getUser,
);

// POST /lookup
router.post(
    "/lookup",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.lookupUserByNationalID,
);

// POST /bulk-import
router.post(
    "/bulk-import",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    bulkImportUpload.single("file"),
    userController.bulkImportUsers,
);

// PATCH /bulk-actions
router.patch(
    "/bulk-actions",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.bulkActions,
);

// PATCH /allocate
router.patch(
    "/allocate",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    userController.allocateUsers,
);

// PATCH /resend-credentials
router.patch(
    "/resend-credentials",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    userController.resendCredentials,
    // No attachCollegeScope — scope check is done manually inside controller via log.college_id
);

// ── COLLECTION ROUTES ─────────────────────────────────────────────────

// GET / — list users
router.get(
    "/",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.getAllUsers,
);

// POST / — create user
router.post(
    "/",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    uploadMix([{ name: "photo", maxCount: 1 }], fileValidation.image),
    userController.createUser,
);

// ── DYNAMIC ROUTES ────────────────────────────────────────────────────

// GET /:id
router.get(
    "/:id",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.getUser,
);

// PATCH /:id — general update
router.patch(
    "/:id",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    uploadMix([{ name: "photo", maxCount: 1 }], fileValidation.image),
    userController.updateUser,
);

// PATCH /:id/deactivate
router.patch(
    "/:id/deactivate",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.deactivateUser,
);

// PATCH /:id/restore
router.patch(
    "/:id/restore",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin"),
    userController.restoreUser,
);

// PATCH /:id/unlock
router.patch(
    "/:id/unlock",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin"),
    userController.unlockUser,
);

// PATCH /:id/force-logout
router.patch(
    "/:id/force-logout",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin"),
    userController.forceLogoutUser,
);

// PATCH /:id/reset-password
router.patch(
    "/:id/reset-password",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    userController.resetUserPassword,
);

// PATCH /:id/role
router.patch(
    "/:id/role",
    protect,
    enforcePasswordChange,
    restrictTo("universityAdmin"),
    userController.changeUserRole,
);

// PATCH /:id/assign-rfid
router.patch(
    "/:id/assign-rfid",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    userController.assignRfid,
);

// PATCH /:id/graduate
router.patch(
    "/:id/graduate",
    protect,
    enforcePasswordChange,
    restrictTo("collegeAdmin"),
    attachCollegeScope,
    userController.graduateUser,
);

export default router;
