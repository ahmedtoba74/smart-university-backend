/**
 * ===================================================================================
 * @file      courseOfferingController.js
 * @desc      Implementation of the Course Offering CRUD operations. Employs stringent
 *            business logic validations including grading sums, schedule conflict
 *            detection against overlapping time constraints, and DR/TA scope guards.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Course Offerings/Controller
 */

import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import CourseCatalog from "../../../DB/models/courseCatalogModel.js";
import Location from "../../../DB/models/locationModel.js";
import Settings from "../../../DB/models/settingsModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import User from "../../../DB/models/userModel.js";
import APIFeatures from "../../utils/apiFeatures.js";
import {
    filterReqBody,
    buildOwnershipFilter,
    applyIsArchivedGuard,
} from "../../utils/controllerUtils.js";
import { hasTimeOverlap } from "../../utils/timeConflict.js";

// ============================================
// INTERNAL BUSINESS LOGIC UTILITIES
// ============================================

/**
 * Validates that the sum of the components in `gradingPolicy` matches the `totalDegree`.
 * All components must be >= 0. Ensures defensive financial-like accuracy for academics.
 *
 * @param {number} totalDegree - The absolute degree total representing 100% of the course weight.
 * @param {Object} gradingPolicy - Components Object { attendance, midterm, assignments, project, finalExam }
 * @throws {AppError} If totalDegree < 1, components are negative, or the sum does not match.
 */
const validateGradingPolicy = (totalDegree, gradingPolicy) => {
    if (totalDegree < 1) {
        throw new AppError("Total degree must be at least 1.", 400);
    }
    if (!gradingPolicy) {
        throw new AppError(
            "Grading policy is required when setting totalDegree.",
            400,
        );
    }

    const components = [
        "attendance",
        "midterm",
        "assignments",
        "project",
        "finalExam",
    ];
    let sum = 0;

    components.forEach((comp) => {
        const val =
            gradingPolicy[comp] !== undefined ? Number(gradingPolicy[comp]) : 0;
        if (val < 0) {
            throw new AppError(
                `Grading component '${comp}' cannot be negative.`,
                400,
            );
        }
        sum += val;
    });

    if (sum !== Number(totalDegree)) {
        throw new AppError(
            `Grading Policy sum (${sum}) must strictly equal totalDegree (${totalDegree}).`,
            400,
        );
    }
};

/**
 * Validates that the provided arrays of IDs map to actual users holding the
 * required teaching staff roles. Prevents students or admins from being assigned as teaching staff.
 *
 * @param {Array<string>} doctorsIds - Array of ObjectId strings for doctors.
 * @param {Array<string>} tasIds - Array of ObjectId strings for TAs.
 * @throws {AppError} If users do not exist or possess incorrect roles.
 */
const validateStaffRoles = async (doctorsIds, tasIds) => {
    if (doctorsIds && doctorsIds.length > 0) {
        const docs = await User.find({ _id: { $in: doctorsIds } }).select(
            "role",
        );
        if (docs.length !== doctorsIds.length) {
            throw new AppError(
                "One or more assigned doctors do not exist.",
                400,
            );
        }
        if (docs.some((d) => d.role !== "doctor")) {
            throw new AppError(
                "All specified doctors must possess the 'doctor' role.",
                400,
            );
        }
    }

    if (tasIds && tasIds.length > 0) {
        const tas = await User.find({ _id: { $in: tasIds } }).select("role");
        if (tas.length !== tasIds.length) {
            throw new AppError("One or more assigned TAs do not exist.", 400);
        }
        if (tas.some((t) => t.role !== "ta")) {
            throw new AppError(
                "All specified TAs must possess the 'ta' role.",
                400,
            );
        }
    }
};

/**
 * Master Schedule Conflict Checker.
 * Loops through proposed schedule slots and structurally queries the database
 * for active offerings in the same semester/year. Detects physical room overlap
 * and human resource overlap ensuring no doctor physically double-books their schedule.
 *
 * @param {Array<Object>} schedule - Array of time slot objects { day, startTime, endTime, location }
 * @param {Array<string>} doctorsIds - Array of doctor IDs to check for human resource overlap
 * @param {string} semester - Current term semester (e.g. 'First')
 * @param {string} academicYear - Current term academic year (e.g. '2025-2026')
 * @param {string|null} excludeOfferingId - ObjectId string to ignore (used during patches/updates)
 * @throws {AppError} If any physical or human schedule collision occurs.
 */
const checkScheduleConflicts = async (
    schedule,
    doctorsIds,
    tasIds,
    semester,
    academicYear,
    excludeOfferingId = null,
) => {
    if (!schedule || schedule.length === 0) return;

    const baseQuery = { semester, academicYear, isArchived: false };
    if (excludeOfferingId) baseQuery._id = { $ne: excludeOfferingId };

    const activeOfferings = await CourseOffering.find(baseQuery).select(
        "schedule doctors_ids tas_ids",
    );

    for (const newSlot of schedule) {
        for (const existingOffering of activeOfferings) {
            if (!existingOffering.schedule) continue;

            for (const existingSlot of existingOffering.schedule) {
                // Ignore differing days
                if (newSlot.day !== existingSlot.day) continue;

                // Evaluate strictly via the Phase 3 timeConflict utility
                if (hasTimeOverlap(newSlot, existingSlot)) {
                    // Block 1: Physical Location Collision
                    if (
                        newSlot.location.toString() ===
                        existingSlot.location.toString()
                    ) {
                        throw new AppError(
                            `Location conflict detected: Room ${newSlot.location} is already occupied on ${newSlot.day} during that timeframe.`,
                            400,
                        );
                    }

                    // Block 2: Human Resource (Doctor) Collision
                    if (
                        doctorsIds &&
                        doctorsIds.length > 0 &&
                        existingOffering.doctors_ids
                    ) {
                        const existingDoctorsStrings =
                            existingOffering.doctors_ids.map((id) =>
                                id.toString(),
                            );
                        const overlappingDoctors = doctorsIds.filter((docId) =>
                            existingDoctorsStrings.includes(docId.toString()),
                        );
                        if (overlappingDoctors.length > 0) {
                            throw new AppError(
                                `Doctor schedule conflict: One or more assigned doctors are already scheduled to teach heavily overlapping sessions on ${newSlot.day}.`,
                                400,
                            );
                        }
                    }

                    // Block 3: Human Resource (TA) Collision
                    if (
                        tasIds &&
                        tasIds.length > 0 &&
                        existingOffering.tas_ids
                    ) {
                        const existingTAsStrings = existingOffering.tas_ids.map(
                            (id) => id.toString(),
                        );
                        const overlappingTAs = tasIds.filter((taId) =>
                            existingTAsStrings.includes(taId.toString()),
                        );
                        if (overlappingTAs.length > 0) {
                            throw new AppError(
                                `TA schedule conflict: One or more assigned TAs are already scheduled to teach heavily overlapping sessions on ${newSlot.day}.`,
                                400,
                            );
                        }
                    }
                }
            }
        }
    }
};

// ============================================
// CONTROLLERS
// ============================================

/**
 * POST /api/v1/course-offerings
 *
 * Creates a new active course offering for the current Term. Auto-derives the parent
 * scoping metadata and rigorously calculates all scheduling conflicts before commit.
 *
 * @param {Request} req JSON containing course_id, schedule, doctors, maxSeats, totalDegree, etc.
 * @param {Response} res 201 Created Response alongside the new resource.
 */
export const createOffering = catchAsync(async (req, res, next) => {
    const allowedFields = [
        "course_id",
        "doctors_ids",
        "tas_ids",
        "schedule",
        "maxSeats",
        "totalDegree",
        "gradingPolicy",
    ];
    const filteredBody = filterReqBody(req.body, allowedFields);

    if (!filteredBody.course_id) {
        return next(
            new AppError(
                "course_id is strictly required to create an offering.",
                400,
            ),
        );
    }

    // 1. Fetch Parent Catalog Course via Ownership Filter (IDOR protection)
    const catalogFilter = buildOwnershipFilter(
        filteredBody.course_id,
        req.user,
    );
    const catalogCourse = await CourseCatalog.findOne(catalogFilter);

    if (!catalogCourse) {
        return next(
            new AppError(
                "Parent Catalog Course not found or not in your jurisdiction.",
                404,
            ),
        );
    }

    // 2. Auto-derive scoped hierarchy elements
    filteredBody.college_id = catalogCourse.college_id;
    filteredBody.department_id = catalogCourse.department_id;

    // 3. Auto-derive strictly managed term properties from singleton
    const settings = await Settings.getSettings();
    filteredBody.academicYear = settings.currentAcademicYear;
    filteredBody.semester = settings.currentSemester;

    // 4. Academic Grading Validation
    if (filteredBody.totalDegree) {
        validateGradingPolicy(
            filteredBody.totalDegree,
            filteredBody.gradingPolicy,
        );
    }

    // 5. Staff Role Verification
    await validateStaffRoles(filteredBody.doctors_ids, filteredBody.tas_ids);

    // 6. Universal Schedule Conflict Checker
    if (filteredBody.schedule && filteredBody.schedule.length > 0) {
        for (const slot of filteredBody.schedule) {
            const location = await Location.findOne({ _id: slot.location });
            if (!location) {
                return next(
                    new AppError(
                        `Invalid location reference in schedule: ${slot.location}`,
                        404,
                    ),
                );
            }
            if (location.status === "maintenance") {
                return next(
                    new AppError(
                        `Location ${slot.location} is under maintenance and cannot be scheduled.`,
                        400,
                    ),
                );
            }
        }
    }

    await checkScheduleConflicts(
        filteredBody.schedule,
        filteredBody.doctors_ids,
        filteredBody.tas_ids,
        filteredBody.semester,
        filteredBody.academicYear,
    );

    try {
        const newOffering = await CourseOffering.create(filteredBody);

        res.status(201).json({
            status: "success",
            data: { offering: newOffering },
        });
    } catch (error) {
        // Handle MongoDB 11000 Specifically for the Term Limit Unique Index
        if (error.code === 11000) {
            return next(
                new AppError(
                    "A course offering for this catalog course fundamentally already exists in this term.",
                    400,
                ),
            );
        }
        return next(error);
    }
});

/**
 * PATCH /api/v1/course-offerings/:id
 *
 * Multi-faceted generalized update endpoint for offering structure. Processes
 * dynamic patching of seats, schemas, grading distribution, and scheduling slots,
 * while automatically re-evaluating strictly bound physical limitations and conflict algorithms.
 *
 * @param {Request} req Payload mapping allowed updates
 * @param {Response} res 200 OK Response updating state
 */
export const updateOffering = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "_id",
    );
    const offering = await CourseOffering.findOne(filter);

    if (!offering) {
        return next(
            new AppError(
                "Offering not found or not within your jurisdiction.",
                404,
            ),
        );
    }

    const allowedFields = [
        "schedule",
        "doctors_ids",
        "tas_ids",
        "maxSeats",
        "totalDegree",
        "gradingPolicy",
    ];
    const filteredBody = filterReqBody(req.body, allowedFields);

    // Block 1: Unified Grading Policy Check
    if (
        filteredBody.totalDegree !== undefined ||
        filteredBody.gradingPolicy !== undefined
    ) {
        if (
            filteredBody.totalDegree === undefined ||
            filteredBody.gradingPolicy === undefined
        ) {
            return next(
                new AppError(
                    "If altering totalDegree or gradingPolicy, both must collectively be supplied.",
                    400,
                ),
            );
        }
        validateGradingPolicy(
            filteredBody.totalDegree,
            filteredBody.gradingPolicy,
        );
    }

    // Block 2: Conflict Checking for Schedule Updates
    if (filteredBody.schedule) {
        // Prioritize incoming payload doctors, fallback to pre-existing state payload
        const checkDoctors = filteredBody.doctors_ids || offering.doctors_ids;
        const checkTAs = filteredBody.tas_ids || offering.tas_ids;
        await checkScheduleConflicts(
            filteredBody.schedule,
            checkDoctors,
            checkTAs,
            offering.semester,
            offering.academicYear,
            offering._id, // Critical: Exclude its own history
        );
    }

    // Block 3: Max Seat Contraction Guard
    if (filteredBody.maxSeats !== undefined) {
        if (filteredBody.maxSeats < offering.currentEnrolled) {
            return next(
                new AppError(
                    `Cannot contract maxSeats (${filteredBody.maxSeats}) beneath the current physical enrollment metric (${offering.currentEnrolled}).`,
                    400,
                ),
            );
        }
    }

    // Block 4: Staff Role Guards
    if (filteredBody.doctors_ids || filteredBody.tas_ids) {
        await validateStaffRoles(
            filteredBody.doctors_ids,
            filteredBody.tas_ids,
        );
    }

    // Apply strictly mapped transformations
    Object.keys(filteredBody).forEach((key) => {
        offering[key] = filteredBody[key];
    });

    try {
        await offering.save();
        res.status(200).json({
            status: "success",
            data: { offering },
        });
    } catch (error) {
        if (error.code === 11000)
            return next(
                new AppError("Duplicate configuration collision.", 400),
            );
        return next(error);
    }
});

/**
 * GET /api/v1/course-offerings/:id/students
 *
 * Dedicated visibility endpoint mapping Phase 3 Scope filters enforcing strict adherence
 * to isolation policy. Allows university Admins, strictly isolated college Admins, and
 * explicitly bound DRs and TAs to visualize their roster of formally processed active students.
 *
 * @param {Request} req Route containing offering ID
 * @param {Response} res 200 OK resolving populated user objects
 */
export const getOfferingStudents = catchAsync(async (req, res, next) => {
    // 1. Ownership & Scope Validation ensuring visibility bounds
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "_id",
    );

    // Explicit Staff Filtration (e.g., { doctors_ids: req.user._id }) generated from authMiddleware logic
    const mergedQuery = { ...filter, ...req.staffFilter };
    const offering = await CourseOffering.findOne(mergedQuery);

    if (!offering) {
        return next(
            new AppError(
                "Offering not found, restricted due to hierarchy separation, or you are not an assigned teaching agent for this course.",
                404,
            ),
        );
    }

    // 2. Fetch Active State Registrations with Pagination
    const baseQuery = {
        course_id: offering._id,
        status: "enrolled",
    };

    const features = new APIFeatures(Enrollment.find(baseQuery), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const enrollments = await features.query.populate({
        path: "student_id",
        select: "name email photo nationalID",
    });

    const totalResults = await new APIFeatures(
        Enrollment.find(baseQuery),
        req.query,
    )
        .filter()
        .countTotal(Enrollment, baseQuery);

    res.status(200).json({
        status: "success",
        results: enrollments.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit),
        totalResults,
        data: { enrollments },
    });
});

/**
 * GET /api/v1/course-offerings/:id/students/:studentId
 *
 * Dedicated visibility endpoint for a specific student's enrollment inside an offering.
 */
export const getOfferingStudent = catchAsync(async (req, res, next) => {
    // 1. Ownership & Scope Validation ensuring visibility bounds
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "_id",
    );

    // Explicit Staff Filtration (e.g., { doctors_ids: req.user._id }) generated from authMiddleware logic
    const mergedQuery = { ...filter, ...req.staffFilter };
    const offering = await CourseOffering.findOne(mergedQuery);

    if (!offering) {
        return next(
            new AppError(
                "Offering not found, restricted due to hierarchy separation, or you are not an assigned teaching agent for this course.",
                404,
            ),
        );
    }

    // 2. Fetch Active State Registration for the specific student
    const enrollment = await Enrollment.findOne({
        course_id: offering._id,
        student_id: req.params.studentId,
        status: "enrolled",
    }).populate({
        path: "student_id",
        select: "name email photo nationalID",
    });

    if (!enrollment) {
        return next(
            new AppError(
                "Student is not actively enrolled in this offering.",
                404,
            ),
        );
    }

    res.status(200).json({
        status: "success",
        data: { enrollment },
    });
});

/**
 * PATCH /api/v1/course-offerings/:id/archive
 *
 * Soft-deletion endpoint terminating public access points. Implements fundamental logic barriers
 * ensuring no offering is dismantled while acting as a living entity to enrolled constituents.
 *
 * @param {Request} req Resource identifier mapped dynamically to payload
 * @param {Response} res 200 OK Acknowledging success mechanism
 */
export const archiveOffering = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const offering = await CourseOffering.findOne(filter);

    if (!offering) return next(new AppError("Offering not found.", 404));
    if (offering.isArchived)
        return next(new AppError("Currently archived.", 400));

    // Fundamental Guard
    const activeEnrollments = await Enrollment.countDocuments({
        course_id: offering._id,
        status: "enrolled",
    });

    if (activeEnrollments > 0) {
        return next(
            new AppError(
                "A course offering acting as a container to active constituents cannot be archived.",
                400,
            ),
        );
    }

    offering.isArchived = true;
    await offering.save();

    res.status(200).json({
        status: "success",
        message: "Successfully isolated resource.",
    });
});

/**
 * PATCH /api/v1/course-offerings/:id/restore
 *
 * Counterpart mechanism neutralizing the boolean soft deletion switch.
 */
export const restoreOffering = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const offering = await CourseOffering.findOne({
        ...filter,
        isArchived: true,
    });

    if (!offering)
        return next(
            new AppError(
                "Archived record non-existent within boundaries.",
                404,
            ),
        );

    // Verify parent catalog course
    const catalog = await CourseCatalog.findById(offering.course_id);
    if (!catalog || catalog.isArchived) {
        return next(
            new AppError(
                "Dependency collision: The root Catalog Course is inaccessible or archived.",
                400,
            ),
        );
    }

    offering.isArchived = false;
    await offering.save();

    res.status(200).json({
        status: "success",
        message: "Resource returned to active status pools.",
    });
});

/**
 * GET /api/v1/course-offerings
 */
export const getAllOfferings = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;

    // Base scoping dynamically merging Admin College Scope & Teaching Agent Formative Scopes
    const baseQuery = {
        ...req.scopeFilter,
        ...req.archivedFilter,
        ...req.staffFilter,
    };

    const features = new APIFeatures(CourseOffering.find(baseQuery), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const offerings = await features.query
        .populate({ path: "course_id", select: "title code creditHours" })
        .populate({ path: "doctors_ids tas_ids", select: "name email photo" })
        .populate({ path: "department_id", select: "name" })
        .populate({ path: "college_id", select: "name" });

    const totalResults = await new APIFeatures(
        CourseOffering.find(baseQuery),
        req.query,
    )
        .filter()
        .countTotal(CourseOffering, baseQuery);

    res.status(200).json({
        status: "success",
        results: offerings.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit),
        totalResults,
        data: { offerings },
    });
});

/**
 * GET /api/v1/course-offerings/:id
 */
export const getOffering = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;

    const filter = buildOwnershipFilter(req.params.id, req.user);
    const baseQuery = {
        ...filter,
        ...req.scopeFilter,
        ...req.archivedFilter,
        ...req.staffFilter,
    };

    const offering = await CourseOffering.findOne(baseQuery)
        .populate({ path: "course_id", select: "title code creditHours" })
        .populate({ path: "doctors_ids tas_ids", select: "name email photo" })
        .populate({ path: "department_id", select: "name" })
        .populate({ path: "college_id", select: "name" })
        .populate({ path: "schedule.location", select: "name" });

    if (!offering)
        return next(
            new AppError(
                "Requested node is non-accessible or strictly unavailable.",
                404,
            ),
        );

    res.status(200).json({
        status: "success",
        data: { offering },
    });
});

// ============================================

export const submitSemesterWork = catchAsync(async (req, res, next) => {
    res.status(501).json({ message: "Pending Future Section 16 Build." });
});
export const verifyGrades = catchAsync(async (req, res, next) => {
    res.status(501).json({ message: "Pending Future Section 16 Build." });
});
