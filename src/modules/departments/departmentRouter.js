import express from 'express';
import * as departmentController from './departmentController.js';
import { protect, restrictTo, attachCollegeScope } from '../../middlewares/authMiddleware.js';

const router = express.Router();

// All department routes require authentication + admin role + college scope
router.use(protect);
router.use(restrictTo('universityAdmin', 'collegeAdmin'));
router.use(attachCollegeScope);

// ─── CRUD ──────────────────────────────────────────────────────────────────
router
    .route('/')
    .get(departmentController.getAllDepartments)
    .post(departmentController.createDepartment);

router
    .route('/:id')
    .get(departmentController.getDepartment)
    .patch(departmentController.updateDepartment);

// ─── Archive / Restore ─────────────────────────────────────────────────────
// Restore is restricted to universityAdmin only — collegeAdmin cannot restore
router.patch('/:id/archive', departmentController.archiveDepartment);
router.patch('/:id/restore', restrictTo('universityAdmin'), departmentController.restoreDepartment);

export default router;
