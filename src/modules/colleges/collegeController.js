import College from '../../../DB/models/collegeModel.js';
import Department from '../../../DB/models/departmentModel.js';
import User from '../../../DB/models/userModel.js';
import APIFeatures from '../../utils/apiFeatures.js';
import catchAsync from '../../utils/catchAsync.js';
import AppError from '../../utils/appError.js';
import {
    applyIsArchivedGuard,
    applyFieldsGuard,
    filterReqBody
} from '../../utils/controllerUtils.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN_ROLES = ['universityAdmin', 'collegeAdmin'];

/** Fields allowed when creating a college */
const CREATE_ALLOWED = ['name', 'code', 'description', 'dean_id', 'establishedYear'];

/** Fields allowed when updating a college (whitelist — never blacklist) */
const UPDATE_ALLOWED = ['name', 'description', 'dean_id', 'establishedYear'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Adds deptCount and studentCount to a college plain object.
 * Runs both DB counts in parallel for performance.
 * @param {Object} collegeObj - plain JS object (from .toObject() or .lean())
 * @returns {Promise<Object>} enriched object
 */
const enrichWithCounts = async (collegeObj) => {
    const [deptCount, studentCount] = await Promise.all([
        Department.countDocuments({ college_id: collegeObj._id }),
        User.countDocuments({ college_id: collegeObj._id, role: 'student', active: true })
    ]);
    return { ...collegeObj, deptCount, studentCount };
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/colleges
 * Accessible by all authenticated users.
 * - Admins: see all fields + deptCount + studentCount
 * - Others (doctor, ta, student): see only name, code, description
 */
export const getAllColleges = catchAsync(async (req, res, next) => {
    // [SECURITY] Validate ?isArchived param — block injection, strip for non-admins
    if (!applyIsArchivedGuard(req, next)) return;

    // [SECURITY] Block protected fields from ?fields param
    if (!applyFieldsGuard(req, next)) return;

    const isAdmin = ADMIN_ROLES.includes(req.user.role);

    const features = new APIFeatures(
        College.find().populate('dean_id', 'name email'),
        req.query
    ).filter().sort().limitFields().paginate();

    const [colleges, totalResults] = await Promise.all([
        features.query,
        features.countTotal(College, {})
    ]);

    // Role-based projection: non-admins see limited fields
    let data;
    if (isAdmin) {
        // Enrich each college with department and student counts (parallel)
        data = await Promise.all(
            colleges.map(c => enrichWithCounts(c.toObject()))
        );
    } else {
        data = colleges.map(c => ({
            _id: c._id,
            name: c.name,
            code: c.code,
            description: c.description
        }));
    }

    res.status(200).json({
        status: 'success',
        results: data.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit),
        totalResults,
        data: { colleges: data }
    });
});

/**
 * GET /api/v1/colleges/:id
 * Single college. Admins get full data + counts. Others get limited fields.
 * Supports ?isArchived=true for admins to view archived colleges.
 */
export const getCollege = catchAsync(async (req, res, next) => {
    // [SECURITY] Validate ?isArchived param
    if (!applyIsArchivedGuard(req, next)) return;
    if (!applyFieldsGuard(req, next)) return;

    const isAdmin = ADMIN_ROLES.includes(req.user.role);

    // Build query filter — pre-hook adds isArchived:false unless overridden
    const filter = { _id: req.params.id };
    if (req.query.isArchived === 'true' && isAdmin) {
        filter.isArchived = true;
    }

    const college = await College.findOne(filter).populate('dean_id', 'name email role');
    if (!college) return next(new AppError('College not found.', 404));

    let data;
    if (isAdmin) {
        data = await enrichWithCounts(college.toObject());
    } else {
        data = {
            _id: college._id,
            name: college.name,
            code: college.code,
            description: college.description
        };
    }

    res.status(200).json({ status: 'success', data: { college: data } });
});

/**
 * POST /api/v1/colleges
 * universityAdmin only.
 * Validates that dean_id (if provided) refers to an existing user.
 */
export const createCollege = catchAsync(async (req, res, next) => {
    // [SECURITY] Whitelist — only allow specific fields from body
    const body = filterReqBody(req.body, CREATE_ALLOWED);

    if (!body.name || !body.code) {
        return next(new AppError('College name and code are required.', 400));
    }

    // Validate dean_id if provided
    if (body.dean_id) {
        const dean = await User.findById(body.dean_id).select('_id active role');
        if (!dean || !dean.active) {
            return next(new AppError('The specified dean does not exist or is inactive.', 404));
        }
        // [SECURITY] Prevent assigning inappropriate roles as dean
        const VALID_DEAN_ROLES = ['doctor', 'universityAdmin', 'collegeAdmin'];
        if (!VALID_DEAN_ROLES.includes(dean.role)) {
            return next(new AppError('The specified user cannot be assigned as dean.', 400));
        }
    }

    const college = await College.create(body);

    res.status(201).json({ status: 'success', data: { college } });
});

/**
 * PATCH /api/v1/colleges/:id
 * universityAdmin only.
 * Whitelist approach — only ALLOWED fields pass through.
 * Pre-hook ensures archived colleges are invisible (can't edit archived College here).
 */
export const updateCollege = catchAsync(async (req, res, next) => {
    // [SECURITY] Whitelist body fields
    const filteredBody = filterReqBody(req.body, UPDATE_ALLOWED);

    if (Object.keys(filteredBody).length === 0) {
        return next(new AppError('No valid fields to update.', 400));
    }

    // Validate dean_id if being updated
    if (filteredBody.dean_id) {
        const dean = await User.findById(filteredBody.dean_id).select('_id active role');
        if (!dean || !dean.active) {
            return next(new AppError('The specified dean does not exist or is inactive.', 404));
        }
        const VALID_DEAN_ROLES = ['doctor', 'universityAdmin', 'collegeAdmin'];
        if (!VALID_DEAN_ROLES.includes(dean.role)) {
            return next(new AppError('The specified user cannot be assigned as dean.', 400));
        }
    }

    // Pre-hook filters archived colleges — null means either not found or archived
    const college = await College.findByIdAndUpdate(
        req.params.id,
        filteredBody,
        { new: true, runValidators: true }
    ).populate('dean_id', 'name email');

    if (!college) return next(new AppError('College not found.', 404));

    res.status(200).json({ status: 'success', data: { college } });
});

/**
 * PATCH /api/v1/colleges/:id/archive
 * universityAdmin only. Soft-deletes the college.
 * Blocked if the college has any active (non-archived) departments.
 */
export const archiveCollege = catchAsync(async (req, res, next) => {
    // Pre-hook hides archived colleges — findById here returns null if already archived
    const college = await College.findById(req.params.id);
    if (!college) return next(new AppError('College not found.', 404));

    // Guard: prevent orphaning active departments
    // Department pre-hook filters to active (isArchived:false) ones automatically
    const activeDeptCount = await Department.countDocuments({ college_id: req.params.id });
    if (activeDeptCount > 0) {
        return next(new AppError(
            `Cannot archive this college. It still has ${activeDeptCount} active department(s). Archive all departments first.`,
            400
        ));
    }

    college.isArchived = true;
    await college.save({ validateBeforeSave: false });

    res.status(204).json({ status: 'success', data: null });
});

/**
 * PATCH /api/v1/colleges/:id/restore
 * universityAdmin only.
 * Uses findOneAndUpdate with explicit { isArchived: true } to bypass the pre-hook.
 * Returns 404 if not found OR if already active (no info leakage).
 */
export const restoreCollege = catchAsync(async (req, res, next) => {
    const college = await College.findOneAndUpdate(
        { _id: req.params.id, isArchived: true },
        { isArchived: false },
        { new: true, runValidators: false }
    ).populate('dean_id', 'name email');

    // null = either doesn't exist OR was already active
    if (!college) {
        return next(new AppError('College not found or is already active.', 404));
    }

    res.status(200).json({ status: 'success', data: { college } });
});
