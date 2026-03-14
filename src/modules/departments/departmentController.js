import Department from '../../../DB/models/departmentModel.js';
import College from '../../../DB/models/collegeModel.js';
import User from '../../../DB/models/userModel.js';
import APIFeatures from '../../utils/apiFeatures.js';
import catchAsync from '../../utils/catchAsync.js';
import AppError from '../../utils/appError.js';
import {
    applyIsArchivedGuard,
    applyFieldsGuard,
    filterReqBody,
    buildOwnershipFilter
} from '../../utils/controllerUtils.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Fields allowed when creating a department */
const CREATE_ALLOWED = ['name', 'code', 'description', 'college_id', 'head_id'];

/** Fields allowed when updating a department (whitelist — never blacklist) */
const UPDATE_ALLOWED = ['name', 'code', 'description', 'head_id'];

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/departments
 * Scoped by attachCollegeScope middleware (req.scopeFilter).
 * - collegeAdmin: sees only their college's departments (enforced by scopeFilter)
 * - universityAdmin: sees all, can narrow with ?college_id=
 */
export const getAllDepartments = catchAsync(async (req, res, next) => {
    // [SECURITY] Validate ?isArchived + ?fields params
    if (!applyIsArchivedGuard(req, next)) return;
    if (!applyFieldsGuard(req, next)) return;

    const features = new APIFeatures(
        Department.find(req.scopeFilter).populate('head_id', 'name email').populate('college_id', 'name code'),
        req.query
    ).filter().sort().limitFields().paginate();

    const [departments, totalResults] = await Promise.all([
        features.query,
        features.countTotal(Department, req.scopeFilter)
    ]);

    res.status(200).json({
        status: 'success',
        results: departments.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit),
        totalResults,
        data: { departments }
    });
});

/**
 * GET /api/v1/departments/:id
 * [SECURITY] IDOR fix: scopeFilter is baked directly into the query filter.
 * A collegeAdmin cannot retrieve a department from another college — gets 404.
 */
export const getDepartment = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;
    if (!applyFieldsGuard(req, next)) return;

    // Merge _id with scopeFilter — collegeAdmin is automatically scoped
    const filter = { _id: req.params.id, ...req.scopeFilter };

    // Allow viewing an archived department if admin explicitly requests it
    if (req.query.isArchived === 'true') {
        filter.isArchived = true;
    }

    const department = await Department.findOne(filter)
        .populate('head_id', 'name email role')
        .populate('college_id', 'name code');

    // 404 covers both "not found" AND "belongs to another college" — no info leakage
    if (!department) return next(new AppError('Department not found.', 404));

    res.status(200).json({ status: 'success', data: { department } });
});

/**
 * POST /api/v1/departments
 * [SECURITY] collegeAdmin: college_id is ALWAYS taken from req.user — never from body.
 * universityAdmin: must provide a valid, non-archived college_id.
 * Validates that head_id (if provided) belongs to the same college.
 */
export const createDepartment = catchAsync(async (req, res, next) => {
    // [SECURITY] Whitelist body
    const body = filterReqBody(req.body, CREATE_ALLOWED);

    if (!body.name || !body.code) {
        return next(new AppError('Department name and code are required.', 400));
    }

    // [SECURITY] Force college_id for collegeAdmin — never trust client value
    if (req.user.role === 'collegeAdmin') {
        body.college_id = req.user.college_id;
    } else {
        // universityAdmin must supply college_id
        if (!body.college_id) {
            return next(new AppError('college_id is required.', 400));
        }
        // Verify the target college exists and is not archived
        // College pre-hook returns null for archived; no custom filter needed
        const college = await College.findById(body.college_id).select('_id');
        if (!college) {
            return next(new AppError('College not found or is archived.', 404));
        }
    }

    // Validate head_id if provided — must be an active user in the same college
    if (body.head_id) {
        const head = await User.findOne({
            _id: body.head_id,
            college_id: body.college_id,
            active: true
        }).select('_id');
        if (!head) {
            return next(new AppError(
                'The specified department head does not exist, is inactive, or does not belong to this college.',
                404
            ));
        }
    }

    const department = await Department.create(body);

    res.status(201).json({ status: 'success', data: { department } });
});

/**
 * PATCH /api/v1/departments/:id
 * [SECURITY] TOCTOU fix: ownership check is baked into the atomic DB query.
 * [SECURITY] Whitelist: only allowed fields pass through.
 * Returns 404 for both "not found" and "not in your college" (no info leakage).
 */
export const updateDepartment = catchAsync(async (req, res, next) => {
    // [SECURITY] Whitelist body fields
    const filteredBody = filterReqBody(req.body, UPDATE_ALLOWED);

    if (Object.keys(filteredBody).length === 0) {
        return next(new AppError('No valid fields to update.', 400));
    }

    // Validate new head_id if being updated
    if (filteredBody.head_id) {
        // We need the department's college first — use ownership filter to fetch
        const existing = await Department.findOne(buildOwnershipFilter(req.params.id, req.user));
        if (!existing) return next(new AppError('Department not found.', 404));

        const head = await User.findOne({
            _id: filteredBody.head_id,
            college_id: existing.college_id,
            active: true
        }).select('_id');

        if (!head) {
            return next(new AppError(
                'The specified department head does not exist, is inactive, or does not belong to this college.',
                404
            ));
        }
    }

    // [SECURITY] Atomic ownership check: collegeAdmin's college_id in the filter
    const filter = buildOwnershipFilter(req.params.id, req.user);

    const department = await Department.findOneAndUpdate(
        filter,
        filteredBody,
        { new: true, runValidators: true }
    ).populate('head_id', 'name email').populate('college_id', 'name code');

    if (!department) return next(new AppError('Department not found.', 404));

    res.status(200).json({ status: 'success', data: { department } });
});

/**
 * PATCH /api/v1/departments/:id/archive
 * [SECURITY] TOCTOU fix: ownership in query filter.
 * Blocked if the department has any active users assigned to it.
 */
export const archiveDepartment = catchAsync(async (req, res, next) => {
    // Atomic ownership check — 404 for both not-found and wrong college
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const department = await Department.findOne(filter);
    if (!department) return next(new AppError('Department not found.', 404));

    // Guard: prevent orphaning active users
    // Users use `active` field — not isArchived
    const activeUserCount = await User.countDocuments({
        department_id: req.params.id,
        active: true
    });

    if (activeUserCount > 0) {
        return next(new AppError(
            `Cannot archive this department. It still has ${activeUserCount} active user(s). Reassign or deactivate them first.`,
            400
        ));
    }

    department.isArchived = true;
    await department.save({ validateBeforeSave: false });

    res.status(204).json({ status: 'success', data: null });
});

/**
 * PATCH /api/v1/departments/:id/restore
 * universityAdmin only (enforced in router).
 * [SECURITY] Parent college must NOT be archived before restoring the department.
 * Check order matters: verify college BEFORE restoring.
 */
export const restoreDepartment = catchAsync(async (req, res, next) => {
    // Find the archived department first (no ownership override — universityAdmin only)
    const department = await Department.findOne({
        _id: req.params.id,
        isArchived: true
    });
    if (!department) {
        return next(new AppError('Department not found or is already active.', 404));
    }

    // Verify the parent college is NOT archived before restoring
    // College pre-hook: College.findById returns null if college is archived
    const parentCollege = await College.findById(department.college_id).select('_id');
    if (!parentCollege) {
        return next(new AppError(
            'Cannot restore this department. Its parent college is archived. Restore the college first.',
            400
        ));
    }

    department.isArchived = false;
    await department.save({ validateBeforeSave: false });

    res.status(200).json({ status: 'success', data: { department } });
});
