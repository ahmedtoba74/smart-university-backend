/**
 * ===================================================================================
 * @file      materialRouter.js
 * @desc      Router for course material management endpoints.
 *            Nested under /api/v1/offerings/:offeringId/materials
 * @module    modules/material/materialRouter
 * @requires  express, authMiddleware, materialController
 * ===================================================================================
 */

import express from "express";
import {
    protect,
    restrictTo,
    attachStaffScope,
    attachCollegeScope,
} from "../../middlewares/authMiddleware.js";
import { uploadMix } from "../../middlewares/uploadMiddleware.js";
import * as materialController from "./materialController.js";

/**
 * Material Router
 *
 * Base path: /api/v1/offerings/:offeringId/materials
 * All routes require authentication and staff role (doctor/TA)
 *
 * Route Parameters:
 * @param {string} offeringId - Course offering ID (from parent router)
 *
 * Middleware Stack:
 * 1. protect - JWT authentication
 * 2. restrictTo - Role-based access control
 * 3. attachStaffScope - Validates staff belongs to course offering
 */
const router = express.Router({ mergeParams: true });

/**
 * @route   POST /api/v1/offerings/:offeringId/materials
 * @desc    Create a new material (upload file or add external link)
 * @access  Doctors & TAs (must be assigned to course)
 * @body    { title, description, category, isExternalLink, url, fileName, fileType }
 */
router.post(
    "/",
    protect,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    attachStaffScope,
    uploadMix(
        [{ name: "file", maxCount: 1 }],
        [
            "application/pdf",
            "video/mp4",
            "image/png",
            "image/jpeg",
            "application/msword",
        ],
    ),
    materialController.createMaterial,
);

/**
 * @route   GET /api/v1/offerings/:offeringId/materials
 * @desc    Get all materials for a course offering
 * @access  Doctors, TAs, Students (enrolled), College Admins
 * @query   ?category=Lectures (optional filter)
 */
router.get(
    "/",
    protect,
    restrictTo("doctor", "ta", "student", "collegeAdmin"),
    attachCollegeScope,
    materialController.getAllMaterials,
);

/**
 * @route   GET /api/v1/offerings/:offeringId/materials/:id
 * @desc    Get a single material by ID
 * @access  Doctors, TAs, Students (enrolled), College Admins
 */
router.get(
    "/:id",
    protect,
    restrictTo("doctor", "ta", "student", "collegeAdmin"),
    attachCollegeScope,
    materialController.getMaterial,
);

/**
 * @route   PATCH /api/v1/offerings/:offeringId/materials/:id
 * @desc    Update a material (title, description, category only)
 * @access  Doctors (any in course) & TAs (only their own materials)
 * @body    { title?, description?, category? }
 */
router.patch(
    "/:id",
    protect,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    attachStaffScope,
    uploadMix(
        [{ name: "file", maxCount: 1 }],
        [
            "application/pdf",
            "video/mp4",
            "image/png",
            "image/jpeg",
            "application/msword",
        ],
    ),
    materialController.updateMaterial,
);

/**
 * @route   DELETE /api/v1/offerings/:offeringId/materials/:id
 * @desc    Delete a material
 * @access  Doctors (any in course) & TAs (only their own materials)
 */
router.delete(
    "/:id",
    protect,
    restrictTo("doctor", "ta"),
    attachCollegeScope,
    attachStaffScope,
    materialController.deleteMaterial,
);

export default router;
