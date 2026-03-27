/**
 * ===================================================================================
 * @file      courseCatalogController.js
 * @desc      Core business logic controllers handling Course Catalog management.
 *            Implements strict multi-tenancy isolation (IDOR protection), circular
 *            dependency recursion constraints, and cascading archive guards.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 */

import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import CourseCatalog from "../../../DB/models/courseCatalogModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import Department from "../../../DB/models/departmentModel.js";
import APIFeatures from "../../utils/apiFeatures.js";
import {
    filterReqBody,
    buildOwnershipFilter,
    applyIsArchivedGuard,
} from "../../utils/controllerUtils.js";

// ============================================
// UTILITIES
// ============================================

/**
 * Validates a list of prerequisite IDs to ensure they:
 * 1. Exist
 * 2. Are not archived
 * 3. Belong to the exact same college_id as the target course
 */
const validatePrerequisites = async (prerequisitesIds, collegeId, next) => {
    if (!prerequisitesIds || prerequisitesIds.length === 0) return true;

    const prerequisites = await CourseCatalog.find({
        _id: { $in: prerequisitesIds },
    });

    if (prerequisites.length !== prerequisitesIds.length) {
        return next(
            new AppError("One or more prerequisite courses do not exist.", 400),
        );
    }

    for (const prereq of prerequisites) {
        if (prereq.isArchived) {
            return next(
                new AppError(
                    `Cannot set archived course (${prereq.code}) as a prerequisite.`,
                    400,
                ),
            );
        }
        if (prereq.college_id.toString() !== collegeId.toString()) {
            return next(
                new AppError(
                    `Prerequisite course (${prereq.code}) belongs to a different college. Prerequisite chains cannot cross colleges.`,
                    400,
                ),
            );
        }
    }

    return true;
};

/**
 * Circular Dependency Checker (Max Depth: 10)
 * Uses recursive DFS to ensure the target course does not appear
 * anywhere in the prerequisite chain of its dependencies.
 */
const checkCircularDependency = async (
    targetCourseId,
    prerequisitesIds,
    depth = 0,
) => {
    if (depth > 10) {
        throw new AppError("Prerequisite chain too deep (max 10 levels).", 400);
    }

    if (!prerequisitesIds || prerequisitesIds.length === 0) return false;

    // Direct check at current level
    if (
        prerequisitesIds.some(
            (id) => id.toString() === targetCourseId.toString(),
        )
    ) {
        return true; // Circular loop detected
    }

    // Traverse down
    for (const prId of prerequisitesIds) {
        const prCourse = await CourseCatalog.findById(prId);
        if (
            prCourse &&
            prCourse.prerequisites_ids &&
            prCourse.prerequisites_ids.length > 0
        ) {
            const isCircular = await checkCircularDependency(
                targetCourseId,
                prCourse.prerequisites_ids,
                depth + 1,
            );
            if (isCircular) return true;
        }
    }

    return false;
};

// ============================================
// CONTROLLERS
// ============================================

/**
 * @function createCourse
 * @desc     POST /api/v1/course-catalog
 *           Creates a new core academic node (Course Catalog entry).
 *           Enforces business rules confirming target Department existence & scope.
 *           Validates topological prerequisites chains resolving 10-level circular
 *           dependencies blocking malformed curricular graphs.
 *
 * @param    {Object} req - Express Request object mapped with payload data.
 * @param    {Object} res - Express Response object.
 * @param    {Function} next - Express Error forwarding middleware.
 * @returns  {Object} 201 Created Response alongside the new resource.
 * @throws   {AppError} 400 Bad Request on circular references or inactive dependents.
 * @throws   {AppError} 404 Not Found if Department identity lacks scope clearance.
 */
export const createCourse = catchAsync(async (req, res, next) => {
    const allowedFields = [
        "title",
        "code",
        "description",
        "creditHours",
        "prerequisites_ids",
        "department_id",
    ];
    const filteredBody = filterReqBody(req.body, allowedFields);

    if (!filteredBody.department_id) {
        return next(new AppError("Department ID is required.", 400));
    }

    // 1. Validate Department and ensure it's in the admin's scope
    const deptQuery = { _id: filteredBody.department_id, ...req.scopeFilter };
    const department = await Department.findOne(deptQuery);

    if (!department) {
        return next(
            new AppError(
                "Department not found or does not belong to your college.",
                404,
            ),
        );
    }

    if (department.isArchived) {
        return next(
            new AppError(
                "Cannot create a course under an archived department.",
                400,
            ),
        );
    }

    // 2. Auto-derive college_id
    filteredBody.college_id = department.college_id;

    // 3. Validate Prerequisites
    if (filteredBody.prerequisites_ids) {
        const isValid = await validatePrerequisites(
            filteredBody.prerequisites_ids,
            filteredBody.college_id,
            next,
        );
        if (isValid !== true) return; // validatePrerequisites already called next()

        // Circular Dependency check for create (using a dummy ID since it doesn't exist yet,
        // though practically impossible unless the user passes the same code somehow)
        // We do this to fulfill strict requirements.
        const dummyId = "000000000000000000000000";
        const isCircular = await checkCircularDependency(
            dummyId,
            filteredBody.prerequisites_ids,
        );
        if (isCircular) {
            return next(
                new AppError("Circular prerequisite dependency detected.", 400),
            );
        }
    }

    try {
        const newCourse = await CourseCatalog.create(filteredBody);

        res.status(201).json({
            status: "success",
            data: {
                course: newCourse,
            },
        });
    } catch (error) {
        // Handle MongoDB 11000 duplicate key error specifically for course code
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new AppError("Course code already exists.", 400));
        }
        return next(error);
    }
});

/**
 * @function getAllCourses
 * @desc     GET /api/v1/course-catalog
 *           Retrieves a globally scoped collection of catalog nodes, seamlessly filtered
 *           for College Administrators while retaining global view for University Admins.
 *           Injects standard API Features (pagination, sort, fields).
 *
 * @param    {Object} req - Express Request.
 * @param    {Object} res - Express Response.
 * @param    {Function} next - Express Error forwarding.
 * @returns  {Object} 200 OK Response wrapped identically with pagination attributes.
 */
export const getAllCourses = catchAsync(async (req, res, next) => {
    // Admin ?isArchived guard
    if (!applyIsArchivedGuard(req, next)) return;

    // Merge scopeFilter and archivedFilter
    const baseQuery = { ...req.scopeFilter, ...req.archivedFilter };

    const features = new APIFeatures(CourseCatalog.find(baseQuery), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const courses = await features.query.populate({
        path: "prerequisites_ids",
        select: "title code",
    });

    const total = await new APIFeatures(
        CourseCatalog.find(baseQuery),
        req.query,
    )
        .filter()
        .countTotal();

    res.status(200).json({
        status: "success",
        results: courses.length,
        total,
        data: {
            courses,
        },
    });
});

/**
 * @function getCourse
 * @desc     GET /api/v1/course-catalog/:id
 *           Looks up a single explicit node verified via strict ownership barriers
 *           using the `buildOwnershipFilter`. Resolves populated prerequisites recursively.
 *
 * @param    {Object} req - Express Request embedding explicit resource :id.
 * @param    {Object} res - Express Response.
 * @param    {Function} next - Express Next Error hook.
 * @returns  {Object} 200 OK resolving populated topological dependencies.
 * @throws   {AppError} 404 if logically nonexistent or beyond user scope bounds.
 */
export const getCourse = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;

    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "code",
    );
    const mergedQuery = { ...filter, ...req.archivedFilter };

    const course = await CourseCatalog.findOne(mergedQuery).populate({
        path: "prerequisites_ids",
        select: "title code",
    });

    if (!course) {
        return next(new AppError("Course not found.", 404));
    }

    res.status(200).json({
        status: "success",
        data: {
            course,
        },
    });
});

/**
 * @function updateCourse
 * @desc     PATCH /api/v1/course-catalog/:id
 *           Transforms root definitions natively restricting protected components.
 *           If structural topology (prerequisites) alters, triggers profound analysis
 *           averting any immediate or recursively chained structural loops.
 *
 * @param    {Object} req - Client Payload describing field deltas & URL :id.
 * @param    {Object} res - Express Response.
 * @param    {Function} next - Express Next hook terminating process blocks.
 * @returns  {Object} 200 OK Response bearing integrated changes.
 * @throws   {AppError} 400 On duplicate mapping logic (11000 Course Code overlap).
 * @throws   {AppError} 404 For jurisdictional bounds violation via OwnershipGuard.
 */
export const updateCourse = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const course = await CourseCatalog.findOne(filter);

    if (!course) {
        return next(new AppError("Course not found.", 404));
    }

    // Only allow specific fields
    const allowedFields = [
        "title",
        "description",
        "creditHours",
        "prerequisites_ids",
    ];
    const filteredBody = filterReqBody(req.body, allowedFields);

    if (filteredBody.prerequisites_ids) {
        const isValid = await validatePrerequisites(
            filteredBody.prerequisites_ids,
            course.college_id,
            next,
        );
        if (isValid !== true) return;

        // Execute Circular Dependency check
        const isCircular = await checkCircularDependency(
            course._id,
            filteredBody.prerequisites_ids,
        );
        if (isCircular) {
            return next(
                new AppError("Circular prerequisite dependency detected.", 400),
            );
        }
    }

    // Update fields
    Object.keys(filteredBody).forEach((key) => {
        course[key] = filteredBody[key];
    });

    try {
        await course.save();

        res.status(200).json({
            status: "success",
            data: {
                course,
            },
        });
    } catch (error) {
        if (error.code === 11000 && error.keyPattern && error.keyPattern.code) {
            return next(new AppError("Course code already exists.", 400));
        }
        return next(error);
    }
});

/**
 * @function archiveCourse
 * @desc     PATCH /api/v1/course-catalog/:id/archive
 *           Triggers standard soft deletion protocols on designated catalog schemas.
 *           Employs active constituent collision boundaries preventing takedown
 *           while living CourseOfferings inherently reference this schema dynamically.
 *
 * @param    {Object} req - Express Request.
 * @param    {Object} res - Express Response.
 * @param    {Function} next - Next error pipeline hook.
 * @returns  {Object} 200 OK success notification.
 * @throws   {AppError} 400 Hard rejection mapping currently live offerings in-memory.
 */
export const archiveCourse = catchAsync(async (req, res, next) => {
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const course = await CourseCatalog.findOne(filter);

    if (!course) {
        return next(new AppError("Course not found.", 404));
    }

    if (course.isArchived) {
        return next(new AppError("Course is already archived.", 400));
    }

    // Guard: Prevent archiving if active offerings exist
    const activeOfferingsCount = await CourseOffering.countDocuments({
        course_id: course._id,
        isArchived: false,
    });

    if (activeOfferingsCount > 0) {
        return next(
            new AppError(
                "Cannot archive a course with active offerings. Please archive or conclude all offerings first.",
                400,
            ),
        );
    }

    course.isArchived = true;
    await course.save();

    res.status(200).json({
        status: "success",
        message: "Course successfully archived.",
        data: {
            course,
        },
    });
});

/**
 * @function restoreCourse
 * @desc     PATCH /api/v1/course-catalog/:id/restore
 *           Revives a historically archived element verifying root dependencies
 *           to avoid rendering active schemas beneath defunct hierarchy tiers.
 *
 * @param    {Object} req - Express Request.
 * @param    {Object} res - Express Response.
 * @param    {Function} next - Next error pipeline.
 * @returns  {Object} 200 OK success notification.
 * @throws   {AppError} 400 If upper topological branch (Department) rests inactive.
 */
export const restoreCourse = catchAsync(async (req, res, next) => {
    // Note: We bypass the default isArchived=false hook because the course is currently archived.
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const course = await CourseCatalog.findOne({ ...filter, isArchived: true });

    if (!course) {
        return next(new AppError("Archived course not found.", 404));
    }

    // Guard Verify parent department is not archived
    const department = await Department.findById(course.department_id);
    if (!department) {
        return next(new AppError("Parent department no longer exists.", 404));
    }
    if (department.isArchived) {
        return next(
            new AppError(
                "Cannot restore course because its parent department is archived. Restore the department first.",
                400,
            ),
        );
    }

    course.isArchived = false;
    await course.save();

    res.status(200).json({
        status: "success",
        message: "Course successfully restored.",
        data: {
            course,
        },
    });
});
