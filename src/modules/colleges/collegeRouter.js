import express from 'express';
import * as collegeController from './collegeController.js';
import { protect, restrictTo } from '../../middlewares/authMiddleware.js';

const router = express.Router();

// All college routes require authentication
router.use(protect);

// ─── Public (all authenticated roles) ─────────────────────────────────────
router
    .route('/')
    .get(collegeController.getAllColleges)
    .post(restrictTo('universityAdmin'), collegeController.createCollege);

router
    .route('/:id')
    .get(collegeController.getCollege)
    .patch(restrictTo('universityAdmin'), collegeController.updateCollege);

// ─── Archive / Restore (universityAdmin only) ─────────────────────────────
router.patch('/:id/archive', restrictTo('universityAdmin'), collegeController.archiveCollege);
router.patch('/:id/restore', restrictTo('universityAdmin'), collegeController.restoreCollege);

export default router;
