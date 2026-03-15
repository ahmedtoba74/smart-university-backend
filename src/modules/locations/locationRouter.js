import express from 'express';
import * as locationController from './locationController.js';
import { protect, restrictTo, attachCollegeScope } from '../../middlewares/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(attachCollegeScope);

// ─── Read (universityAdmin, collegeAdmin, doctor, ta) ─────────────────────
router
    .route('/')
    .get(
        restrictTo('universityAdmin', 'collegeAdmin', 'doctor', 'ta'),
        locationController.getAllLocations
    );

router
    .route('/:id')
    .get(
        restrictTo('universityAdmin', 'collegeAdmin', 'doctor', 'ta'),
        locationController.getLocation
    )
    .patch(
        restrictTo('universityAdmin', 'collegeAdmin'),
        locationController.updateLocation
    );

// ─── Create (universityAdmin, collegeAdmin) ────────────────────────────────
router.post('/', restrictTo('universityAdmin', 'collegeAdmin'), locationController.createLocation);

// ─── Status toggle (universityAdmin, collegeAdmin) ────────────────────────
router.patch(
    '/:id/status',
    restrictTo('universityAdmin', 'collegeAdmin'),
    locationController.updateLocationStatus
);

// ─── Archive / Restore ─────────────────────────────────────────────────────
router.patch(
    '/:id/archive',
    restrictTo('universityAdmin'),
    locationController.archiveLocation
);

router.patch(
    '/:id/restore',
    restrictTo('universityAdmin', 'collegeAdmin'),
    locationController.restoreLocation
);

export default router;
