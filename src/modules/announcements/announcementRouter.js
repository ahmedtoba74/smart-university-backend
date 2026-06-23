/**
 * ===================================================================================
 * @file      announcementRouter.js
 * @desc      Router defining API endpoints for Announcements.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Announcements/Router
 */

// src/modules/announcements/announcementRouter.js

import express from "express";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";
import {
    createAnnouncement,
    getAnnouncements,
    getAnnouncementById,
    deleteAnnouncement,
} from "./announcementController.js";

const router = express.Router();

// All announcement routes require a valid JWT and an active (non-temporary) password.
// enforcePasswordChange blocks users with requiresPasswordChange = true from all routes
// except the password change and logout endpoints defined in authRouter.js.
router.use(protect);
router.use(enforcePasswordChange);

// PATCH is intentionally omitted for v1.
// Announcements are immutable after broadcast — soft-delete and repost instead.

router
    .route("/")
    .post(
        restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta"),
        createAnnouncement,
    )
    .get(getAnnouncements);

router
    .route("/:id")
    .get(getAnnouncementById)
    .delete(
        restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta"),
        deleteAnnouncement,
    );

export default router;
