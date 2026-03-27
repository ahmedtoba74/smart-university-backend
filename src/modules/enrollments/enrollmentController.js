/**
 * ===================================================================================
 * @file      enrollmentController.js
 * @desc      The definitive Phase 3 Enrollment Engine. Acts as the master controller
 *            for all Registration interactions. Engineers robust transaction isolation
 *            overcoming historic Phantom Read/Write scenarios via explicit Write-Locks
 *            coupled with multi-stage Gate verifications (Term, Credit Limit,
 *            Prerequisites, Atomic Capacity).
 * @author    Ahmed Toba
 * @version   2.5.0
 * ===================================================================================
 */

import mongoose from "mongoose";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import CourseCatalog from "../../../DB/models/courseCatalogModel.js";
import User from "../../../DB/models/userModel.js";
import Settings from "../../../DB/models/settingsModel.js";
import APIFeatures from "../../utils/apiFeatures.js";
import { buildOwnershipFilter } from "../../utils/controllerUtils.js";
import { hasTimeOverlap } from "../../utils/timeConflict.js";

// ============================================
// INTERNAL UTILITIES / GATES
// ============================================

/**
 * Executes **Gate 3: Prerequisite Verification** (Outside Transaction).
 * Evaluates the required academic dependency tree for a target course utilizing
 * an optimized aggregation strategy strictly fetching `passed` milestones.
 *
 * @param {string} studentId - The target student's ObjectId.
 * @param {Array<string>} prerequisitesIds - Array of required CourseCatalog ObjectIds.
 * @throws {AppError} If the subset of historically passed prerequisites lacks the total requirement.
 */
const verifyPrerequisites = async (studentId, prerequisitesIds) => {
    if (!prerequisitesIds || prerequisitesIds.length === 0) return;

    // Utilize Gate 3 Optimization Index
    const passedPrereqs = await Enrollment.find({
        student_id: studentId,
        catalogCourse_id: { $in: prerequisitesIds },
        status: "passed",
    }).select("catalogCourse_id");

    const passedSet = new Set(
        passedPrereqs.map((p) => p.catalogCourse_id.toString()),
    );

    const missing = prerequisitesIds.filter(
        (pId) => !passedSet.has(pId.toString()),
    );

    if (missing.length > 0) {
        throw new AppError(
            `Academic Block: Student has not formally passed ${missing.length} necessary prerequisite courses.`,
            400,
        );
    }
};

/**
 * Master Time Conflict Dispatcher. Checks active schedules ensuring
 * the newly requested Offering Schedule does not collide temporally
 * with the student's universally active footprint for the term.
 *
 * @param {string} studentId - The student whose schedule is analyzed.
 * @param {Object} incomingOffering - The populated offering being targeted.
 * @param {Object} settings - Derived global settings controlling active terms.
 * @throws {AppError} Generates a 409 Conflict indicating overlapping constraints.
 */
const verifyTimeConflicts = async (studentId, incomingOffering, settings) => {
    if (!incomingOffering.schedule || incomingOffering.schedule.length === 0)
        return;

    const activeEnrollments = await Enrollment.find({
        student_id: studentId,
        status: "enrolled",
        academicYear: settings.currentAcademicYear, // Term boundary
        semester: settings.currentSemester, // Term boundary
    }).populate("course_id"); // Mapped as course_id acting as CourseOffering reference

    for (const active of activeEnrollments) {
        const activeOffering = active.course_id;
        if (!activeOffering || !activeOffering.schedule) continue;

        for (const newSlot of incomingOffering.schedule) {
            for (const existSlot of activeOffering.schedule) {
                // Strict Collision Metric
                if (
                    newSlot.day === existSlot.day &&
                    hasTimeOverlap(newSlot, existSlot)
                ) {
                    throw new AppError(
                        `Schedule Conflict: Temporal collision detected on ${newSlot.day} with actively enrolled course: ${active.snapshot.courseTitle}`,
                        409,
                    );
                }
            }
        }
    }
};

/**
 * Helper to strip obscured grading vectors prior to formal release.
 * Designed to filter out `finalTotal` and `finalLetter` explicitly for
 * students natively traversing before `resultsPublished` is universally cleared.
 *
 * @param {Array<Object>} enrollments - Pure JSON representations of queried enrollments.
 */
const sanitizeGradesPayload = (enrollments) => {
    enrollments.forEach((enr) => {
        // Evaluate attached offering node representing live status checks
        const offering = enr.course_id;
        if (offering && offering.resultsPublished === false) {
            if (enr.grades) {
                enr.grades.finalTotal = undefined;
                enr.grades.finalLetter = undefined;
            }
        }
    });
};

// ============================================
// CONTROLLERS
// ============================================

/**
 * @function enrollStudent
 * @desc     POST /api/v1/enrollments
 *           Master operational mechanism executing synchronous isolation over massive
 *           student concurrency spikes.
 *           Pre-Tx: Resolves open enrollment timelines natively bounded by physical prerequisites & term conflicts.
 *           In-Tx: Issues `findByIdAndUpdate` serving as a critical Write-Lock neutralizing Phantom Read injections,
 *           sequentially validating Credit Limitations (Gate 2) and Atomic Component Increments (Gate 4) resolving completely ACID state.
 *
 * @param {Object} req  Express Payload mapping target courseOffering_id
 * @param {Object} res  201 Return Pipeline
 * @param {Function} next Standard execution router
 */
export const enrollStudent = catchAsync(async (req, res, next) => {
    const offeringId = req.body.courseOffering_id;
    if (!offeringId)
        return next(
            new AppError("Course Offering ID is intrinsically required.", 400),
        );

    // 1. Fetch live contextual metadata leveraging global settings singleton
    const settings = await Settings.getSettings();

    // 2. Fetch Targeted Resource validating structural clearance (isArchived, college_id)
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        college_id: req.user.college_id,
        isArchived: false,
    }).populate({
        path: "course_id", // maps to CourseCatalog
        select: "title code creditHours prerequisites_ids",
    });

    if (!offering || !offering.course_id) {
        return next(
            new AppError(
                "Requested catalog offering functionally does not exist or lacks structural boundaries for registration.",
                404,
            ),
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // PRE-TRANSACTION (Lightweight Logic Gates)
    // ─────────────────────────────────────────────────────────────────

    // Gate 1: Term Availability & Standing
    if (!settings.isEnrollmentOpen) {
        return next(
            new AppError(
                "Registrar has disabled the global enrollment window.",
                403,
            ),
        );
    }
    if (["graduated", "suspended"].includes(req.user.academicStatus)) {
        return next(
            new AppError(
                `Academic restriction applied on status: ${req.user.academicStatus}`,
                403,
            ),
        );
    }

    // Gate 3: Core Prerequisite Verification
    await verifyPrerequisites(
        req.user._id,
        offering.course_id.prerequisites_ids,
    );

    // Time Conflict Filter
    await verifyTimeConflicts(req.user._id, offering, settings);

    // ─────────────────────────────────────────────────────────────────
    // MULTIDOC ACID TRANSACTION
    // ─────────────────────────────────────────────────────────────────
    const session = await mongoose.startSession();
    let newEnrollmentRes;

    try {
        await session.withTransaction(async () => {
            // 1. **CRITICAL ARCHITECTURE: USER WRITE-LOCK**
            const lockedUser = await User.findByIdAndUpdate(
                req.user._id,
                { $set: { lastEnrollmentAttempt: Date.now() } },
                { new: true, session },
            );

            if (!lockedUser)
                throw new AppError(
                    "Systemic session integrity lock failed.",
                    400,
                );

            // 2. **Gate 2: Active Credit Limit Resolution**
            const targetCreditHours = offering.course_id.creditHours || 0;
            const maxAllowed =
                settings.defaultCreditLimit[lockedUser.academicStatus] || 18;

            const creditAggregation = await Enrollment.aggregate(
                [
                    {
                        $match: {
                            student_id: lockedUser._id,
                            status: "enrolled",
                            academicYear: settings.currentAcademicYear,
                            semester: settings.currentSemester,
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalCredits: { $sum: "$snapshot.creditHours" },
                        },
                    },
                ],
                { session },
            );

            const currentCredits =
                creditAggregation.length > 0
                    ? creditAggregation[0].totalCredits
                    : 0;

            if (currentCredits + targetCreditHours > maxAllowed) {
                throw new AppError(
                    `Credit Cap Reached: Request exceeds maximum allowed credits (${maxAllowed}). Current: ${currentCredits}, Demanded: ${targetCreditHours}.`,
                    400,
                );
            }

            // 3. **Gate 4: Atomic Capacity Controller**
            const atomicOfferingUpdate = await CourseOffering.findOneAndUpdate(
                {
                    _id: offering._id,
                    $expr: { $lt: ["$currentEnrolled", "$maxSeats"] },
                },
                { $inc: { currentEnrolled: 1 } },
                { new: true, session },
            );

            if (!atomicOfferingUpdate) {
                throw new AppError(
                    "Capacity Lock triggered: Section has reached its functional seating capacity.",
                    400,
                );
            }

            // 4. Construct Core Linkage Payload
            const [newEnrollment] = await Enrollment.create(
                [
                    {
                        student_id: lockedUser._id,
                        course_id: offering._id,
                        catalogCourse_id: offering.course_id._id,
                        college_id: offering.college_id,
                        semester: settings.currentSemester,
                        academicYear: settings.currentAcademicYear,
                        status: "enrolled",
                        snapshot: {
                            courseCode: offering.course_id.code,
                            courseTitle: offering.course_id.title,
                            creditHours: targetCreditHours,
                        },
                    },
                ],
                { session },
            );

            newEnrollmentRes = newEnrollment;
        });

        return res.status(201).json({
            status: "success",
            data: { enrollment: newEnrollmentRes },
        });
    } catch (error) {
        // Idempotent 11000 Handle Strategy (System resilience against UI double-clicks)
        if (error.code === 11000) {
            const existing = await Enrollment.findOne({
                student_id: req.user._id,
                catalogCourse_id: offering.course_id._id,
                semester: settings.currentSemester,
                academicYear: settings.currentAcademicYear,
                status: { $in: ["enrolled", "passed", "failed"] },
            });
            if (existing) {
                return res.status(200).json({
                    status: "success",
                    message:
                        "Indicates historical or active resolution identically matched constraints.",
                    data: { enrollment: existing },
                });
            }
        }
        return next(error);
    } finally {
        session.endSession();
    }
});

/**
 * @function forceEnrollStudent
 * @desc     POST /api/v1/enrollments/force
 *           Privileged Controller serving Registrar overrides. Evaluates explicit administrative scopes
 *           while unconditionally bypassing standard validations identically preserving systemic
 *           Write-Locks and attaching a permanent audit ledger (`forceEnrolled`).
 *
 * @param {Object} req Extracted fields containing overrides & student identification
 * @param {Object} res 201 Response with Audit mapping
 */
export const forceEnrollStudent = catchAsync(async (req, res, next) => {
    const {
        student_id,
        courseOffering_id,
        overrideCreditLimit,
        overrideCapacity,
        reason,
    } = req.body;

    if (!student_id || !courseOffering_id)
        return next(
            new AppError("Missing fundamental linkage parameters.", 400),
        );

    // Validate global administrative jurisdiction
    const scopeCheckFilter = { ...req.scopeFilter };
    if (req.user.role === "collegeAdmin") {
        // Enforce both elements physically reside in the same college scope constraint
        scopeCheckFilter.college_id = req.user.college_id;
    }

    const student = await User.findOne({
        _id: student_id,
        role: "student",
        ...scopeCheckFilter,
    });
    if (!student)
        return next(
            new AppError(
                "Target student unavailable or inherently out of scope boundaries.",
                404,
            ),
        );

    const offering = await CourseOffering.findOne({
        _id: courseOffering_id,
        isArchived: false,
        ...scopeCheckFilter,
    }).populate({ path: "course_id", select: "title code creditHours" });
    if (!offering)
        return next(
            new AppError(
                "Target offering unavailable or inherently out of scope boundaries.",
                404,
            ),
        );

    const settings = await Settings.getSettings();

    // Check overlaps conditionally inside/outside. (Here, pre-computation bounds Time Validation)
    await verifyTimeConflicts(student._id, offering, settings);

    const session = await mongoose.startSession();
    let newEnrollmentRes;

    try {
        await session.withTransaction(async () => {
            // Locked explicitly to TARGET constituent
            const lockedStudent = await User.findByIdAndUpdate(
                student._id,
                { $set: { lastEnrollmentAttempt: Date.now() } },
                { new: true, session },
            );

            if (!lockedStudent)
                throw new AppError(
                    "Student systemic transaction lock failure.",
                    400,
                );

            const targetCreditHours = offering.course_id.creditHours || 0;
            let gatesBypassed = [];

            // Conditional Gate 2
            if (!overrideCreditLimit) {
                const maxAllowed =
                    settings.defaultCreditLimit[lockedStudent.academicStatus] ||
                    18;
                const creditAgg = await Enrollment.aggregate(
                    [
                        {
                            $match: {
                                student_id: lockedStudent._id,
                                status: "enrolled",
                                academicYear: settings.currentAcademicYear,
                                semester: settings.currentSemester,
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                totalCredits: { $sum: "$snapshot.creditHours" },
                            },
                        },
                    ],
                    { session },
                );

                const current =
                    creditAgg.length > 0 ? creditAgg[0].totalCredits : 0;
                if (current + targetCreditHours > maxAllowed) {
                    throw new AppError(
                        `Transaction Blocked: Credit capacity violation unresolved without explicit override flag.`,
                        400,
                    );
                }
            } else {
                gatesBypassed.push("credit_limit");
            }

            // Conditional Gate 4
            let capacityQuery = { _id: offering._id };
            if (!overrideCapacity)
                capacityQuery.$expr = {
                    $lt: ["$currentEnrolled", "$maxSeats"],
                };

            const updatedOffering = await CourseOffering.findOneAndUpdate(
                capacityQuery,
                { $inc: { currentEnrolled: 1 } },
                { new: true, session },
            );

            if (!updatedOffering) {
                if (!overrideCapacity) {
                    throw new AppError(
                        "Transaction Blocked: Physical capacity restrictions unresolved without explicit override flag.",
                        400,
                    );
                } else {
                    throw new AppError(
                        "Critical database disruption on capacity allocation.",
                        500,
                    );
                }
            }

            if (overrideCapacity) gatesBypassed.push("capacity");

            const [newEnrollment] = await Enrollment.create(
                [
                    {
                        student_id: lockedStudent._id,
                        course_id: offering._id,
                        catalogCourse_id: offering.course_id._id,
                        college_id: offering.college_id,
                        semester: settings.currentSemester,
                        academicYear: settings.currentAcademicYear,
                        status: "enrolled",
                        snapshot: {
                            courseCode: offering.course_id.code,
                            courseTitle: offering.course_id.title,
                            creditHours: targetCreditHours,
                        },
                        forceEnrolled: {
                            forcedBy: req.user._id,
                            forcedAt: Date.now(),
                            reason:
                                reason ||
                                "Administrative override protocols enacted.",
                            gatesBypassed,
                            overrideCapacity: Boolean(overrideCapacity),
                            overrideCreditLimit: Boolean(overrideCreditLimit),
                        },
                    },
                ],
                { session },
            );

            newEnrollmentRes = newEnrollment;
        });

        res.status(201).json({
            status: "success",
            data: { enrollment: newEnrollmentRes },
        });
    } catch (error) {
        if (error.code === 11000)
            return next(
                new AppError("Duplicate configuration collision.", 400),
            );
        return next(error);
    } finally {
        session.endSession();
    }
});

/**
 * @function withdrawStudent
 * @desc     PATCH /api/v1/enrollments/:id/withdraw
 *           Manages transactional withdrawal mapping explicitly reversing capacity values
 *           while locking historical audit states. Determines implicit user bounds
 *           between Admin constraints vs self-guided Student endpoints.
 *
 * @param {Object} req URL indicating Enrollment ID
 * @param {Object} res 200 OK
 */
export const withdrawStudent = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "_id",
    );
    const settings = await Settings.getSettings();

    // Students explicitly boundary-check against themselves AND term availability.
    if (req.user.role === "student") {
        filter.student_id = req.user._id;
        if (!settings.isEnrollmentOpen) {
            return next(
                new AppError(
                    "Registrar term is closed. Official Add/Drop boundaries apply.",
                    403,
                ),
            );
        }
    }

    const enrollment = await Enrollment.findOne(filter);

    if (!enrollment) {
        return next(
            new AppError(
                "Identified mapping not geographically accessible or completely invalid.",
                404,
            ),
        );
    }
    if (enrollment.status !== "enrolled") {
        return next(
            new AppError(
                `Withdrawal protocol negated; explicit state indicates: ${enrollment.status}`,
                400,
            ),
        );
    }

    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            enrollment.status = "withdrawn";
            await enrollment.save({ session });

            // Decrease capacity intrinsically checking floor value to prevent negative corruption
            await CourseOffering.findOneAndUpdate(
                { _id: enrollment.course_id, currentEnrolled: { $gt: 0 } },
                { $inc: { currentEnrolled: -1 } },
                { session },
            );
        });

        res.status(200).json({ status: "success", data: { enrollment } });
    } catch (error) {
        return next(error);
    } finally {
        session.endSession();
    }
});

/**
 * @function getMyEnrollments
 * @desc     GET /api/v1/enrollments/my
 *           Extracts self-identifying enrollment history logically restricted to the active requesting token.
 *           Injects critical parsing logic actively concealing grading thresholds unapproved for mass broadcast.
 */
export const getMyEnrollments = catchAsync(async (req, res, next) => {
    const filter = { student_id: req.user._id };

    const features = new APIFeatures(Enrollment.find(filter), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    // Populate providing insight required for mapping results
    const rawEnrollments = await features.query
        .populate({
            path: "course_id",
            select: "resultsPublished academicYear semester",
        })
        .lean();

    sanitizeGradesPayload(rawEnrollments);

    const total = await new APIFeatures(Enrollment.find(filter), req.query)
        .filter()
        .countTotal();

    res.status(200).json({
        status: "success",
        results: rawEnrollments.length,
        total,
        data: { enrollments: rawEnrollments },
    });
});

/**
 * @function getAllEnrollments
 * @desc     GET /api/v1/enrollments
 *           Extracts administrative collections globally leveraging mapped college scope constraints.
 */
export const getAllEnrollments = catchAsync(async (req, res, next) => {
    const baseQuery = { ...req.scopeFilter };

    const features = new APIFeatures(Enrollment.find(baseQuery), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const enrollments = await features.query.populate("student_id course_id");
    const total = await new APIFeatures(Enrollment.find(baseQuery), req.query)
        .filter()
        .countTotal();

    res.status(200).json({
        status: "success",
        results: enrollments.length,
        total,
        data: { enrollments },
    });
});

/**
 * @function getEnrollmentById
 * @desc     GET /api/v1/enrollments/:id
 *           Looks up localized exact mapping logically verified via systemic boundary validations.
 */
export const getEnrollmentById = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(req.params.id, req.user);

    const enrollment = await Enrollment.findOne(filter).populate(
        "student_id course_id",
    );
    if (!enrollment)
        return next(
            new AppError(
                "Specified ID invalid or heavily inaccessible under bounds.",
                404,
            ),
        );

    if (
        req.user.role === "student" &&
        enrollment.student_id._id.toString() !== req.user._id.toString()
    ) {
        return next(
            new AppError("Forbidden jurisdiction boundaries accessed.", 403),
        );
    }

    res.status(200).json({ status: "success", data: { enrollment } });
});
