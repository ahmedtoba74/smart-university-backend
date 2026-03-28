import express from "express";
import * as courseOfferingController from "./courseOfferingController.js";
import {
    protect,
    restrictTo,
    attachCollegeScope,
    attachStaffScope,
} from "../../middlewares/authMiddleware.js";
import { enforcePasswordChange } from "../../middlewares/enforcePasswordChange.js";

const router = express.Router({ mergeParams: true });

// ─── Nested Route Interceptor ─────────────────────────────────────────
export const setNestedOfferingFilters = (req, res, next) => {
    if (req.params.collegeId) {
        req.query.college_id = req.params.collegeId;
    }
    next();
};
router.use(setNestedOfferingFilters);

// All routes require authentication and password rotation check
router.use(protect);
router.use(enforcePasswordChange);

// ─── COLLECTION ROUTES ────────────────────────────────────────────────

router
    .route("/")
    .get(
        restrictTo(
            "universityAdmin",
            "collegeAdmin",
            "doctor",
            "ta",
            "student",
        ),
        attachCollegeScope,
        attachStaffScope, // CRITICAL: Injects doctors_ids / tas_ids filters
        courseOfferingController.getAllOfferings,
    )
    .post(
        restrictTo("universityAdmin", "collegeAdmin"),
        attachCollegeScope,
        courseOfferingController.createOffering,
    );

// ─── DYNAMIC ROUTES (General) ─────────────────────────────────────────

router
    .route("/:id")
    .get(
        restrictTo(
            "universityAdmin",
            "collegeAdmin",
            "doctor",
            "ta",
            "student",
        ),
        attachCollegeScope,
        attachStaffScope,
        courseOfferingController.getOffering,
    )
    .patch(
        restrictTo("universityAdmin", "collegeAdmin"),
        attachCollegeScope,
        courseOfferingController.updateOffering,
    );

// Grading & Semester Work Endpoints (from Section 16)
router.patch(
    "/:id/grades/semester-work",
    restrictTo("doctor"),
    attachCollegeScope,
    attachStaffScope,
    courseOfferingController.submitSemesterWork,
);

router.patch(
    "/:id/grades/verify",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    courseOfferingController.verifyGrades,
);

// ─── ARCHIVE ROUTES ───────────────────────────────────────────────────

router.patch(
    "/:id/archive",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    courseOfferingController.archiveOffering,
);

router.patch(
    "/:id/restore",
    restrictTo("universityAdmin", "collegeAdmin"),
    attachCollegeScope,
    courseOfferingController.restoreOffering,
);

// ─── OFFERING STUDENTS ────────────────────────────────────────────────
// GET /:id/students for doctors/TAs to view enrolled students

router.get(
    "/:id/students",
    restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta"),
    attachCollegeScope,
    attachStaffScope,
    courseOfferingController.getOfferingStudents,
);

// GET /:id/students/:studentId for doctors/TAs to view a specific enrolled student
router.get(
    "/:id/students/:studentId",
    restrictTo("universityAdmin", "collegeAdmin", "doctor", "ta"),
    attachCollegeScope,
    attachStaffScope,
    courseOfferingController.getOfferingStudent,
);

export default router;
