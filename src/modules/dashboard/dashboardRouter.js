/**
 * ===================================================================================
 * @file      dashboardRouter.js
 * @desc      Router for the Dashboard Summary endpoint.
 *            Single endpoint: GET /api/v1/dashboard/summary
 *            Role-shaped response — payload determined server-side from JWT.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Dashboard/Router
 */

import express from "express";
import { protect } from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";
import { getSummary } from "./dashboardController.js";

const router = express.Router();

/**
 * GET /api/v1/dashboard/summary
 *
 * Returns a role-shaped dashboard payload.
 * - universityAdmin / collegeAdmin  →  admin stats, charts, config
 * - doctor / ta                     →  my offerings, grades, upcoming
 * - student                         →  GPA, attendance, my courses, upcoming
 *
 * Auth: JWT Bearer token required (protect middleware).
 * The endpoint never accepts a role or scope in the request body/query —
 * everything is derived from req.user injected by protect.
 */
router.get("/summary", protect, enforcePasswordChange, getSummary);

export default router;
