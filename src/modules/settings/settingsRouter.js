/**
 * ===================================================================================
 * @file      settingsRouter.js
 * @desc      Router defining API endpoints for Settings.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Settings/Router
 */

import express from 'express';
import { getSettings, updateSettings } from './settingsController.js';
import { protect, restrictTo } from '../../middlewares/authMiddleware.js';

const router = express.Router();

router.use(protect);

router
    .route('/')
    .get(getSettings)
    .patch(restrictTo('universityAdmin'), updateSettings);

export default router;
