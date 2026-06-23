/**
 * ===================================================================================
 * @file      uploadRouter.js
 * @desc      Router defining API endpoints for Media Uploads.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Media Uploads/Router
 */

// uploadRouter.js
import express from "express";
import { protect } from "../../middlewares/authMiddleware.js";
import { uploadMix } from "../../middlewares/uploadMiddleware.js";
import { uploadGeneralFile } from "./uploadController.js";

const router = express.Router();

router.use(protect); // Any logged-in user can upload

router.post(
    "/",
    uploadMix(
        [{ name: "file", maxCount: 1 }],
        ["image/jpeg", "image/png", "application/pdf", "application/msword"],
    ),
    uploadGeneralFile,
);

export default router;
