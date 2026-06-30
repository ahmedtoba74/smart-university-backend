/**
 * ===================================================================================
 * @file      settingsRouter.js
 * @desc      Router defining API endpoints for Settings.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Settings/Router
 */

import express from "express";
import { getSettings, updateSettings } from "./settingsController.js";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";

const router = express.Router();

router.use(protect);

router
    .route("/")
    // F-05: restrict settings read to admins only — students must not see grade thresholds,
    // token budgets, or any other system configuration internals.
    .get(restrictTo("universityAdmin", "collegeAdmin"), getSettings)
    .patch(restrictTo("universityAdmin"), updateSettings);

export default router;
