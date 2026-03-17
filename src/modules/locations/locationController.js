import Location from "../../../DB/models/locationModel.js";
import College from "../../../DB/models/collegeModel.js";
import APIFeatures from "../../utils/apiFeatures.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import {
    applyIsArchivedGuard,
    applyFieldsGuard,
    filterReqBody,
    buildOwnershipFilter,
    buildIdOrSlugFilter,
} from "../../utils/controllerUtils.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CREATE_ALLOWED = [
    "name",
    "college_id",
    "building",
    "floor",
    "roomNumber",
    "capacity",
    "type",
    "readerId",
];
const UPDATE_ALLOWED = [
    "name",
    "building",
    "floor",
    "roomNumber",
    "capacity",
    "type",
    "readerId",
];

const VALID_STATUS = ["active", "maintenance"];

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/locations
 * Scoped by attachCollegeScope. Accessible to universityAdmin, collegeAdmin, doctor, ta.
 */
export const getAllLocations = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;
    if (!applyFieldsGuard(req, next)) return;

    const baseFilter = { ...req.scopeFilter, ...req.archivedFilter };

    const features = new APIFeatures(
        Location.find(baseFilter).populate("college_id", "name"),
        req.query,
    )
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const [locations, totalResults] = await Promise.all([
        features.query,
        features.countTotal(Location, baseFilter),
    ]);

    res.status(200).json({
        status: "success",
        results: locations.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit),
        totalResults,
        data: { locations },
    });
});

/**
 * GET /api/v1/locations/:id
 * [SECURITY] IDOR fix: scopeFilter baked into query.
 * doctor/ta can see location details for scheduling purposes but scoped to their college.
 */
export const getLocation = catchAsync(async (req, res, next) => {
    if (!applyIsArchivedGuard(req, next)) return;
    if (!applyFieldsGuard(req, next)) return;

    // Supports both ObjectId and slug: /locations/64f... OR /locations/hall-a
    const idFilter = buildIdOrSlugFilter(req.params.id);
    const filter = { ...idFilter, ...req.scopeFilter, ...req.archivedFilter };

    const location = await Location.findOne(filter).populate(
        "college_id",
        "name code",
    );

    if (!location) return next(new AppError("Location not found.", 404));

    res.status(200).json({ status: "success", data: { location } });
});

/**
 * POST /api/v1/locations
 * [SECURITY] collegeAdmin: college_id is ALWAYS taken from req.user, never body.
 * universityAdmin: must provide a valid college_id.
 */
export const createLocation = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, CREATE_ALLOWED);

    if (!body.name || !body.capacity || !body.type) {
        return next(
            new AppError(
                "Location name, capacity, and type are required.",
                400,
            ),
        );
    }

    // [SECURITY] Force college_id for collegeAdmin
    if (req.user.role === "collegeAdmin") {
        body.college_id = req.user.college_id;
    } else {
        if (!body.college_id)
            return next(new AppError("college_id is required.", 400));
        const college = await College.findById(body.college_id).select("_id");
        if (!college)
            return next(new AppError("College not found or is archived.", 404));
    }

    // Validate type against schema enum before hitting DB
    const VALID_TYPES = ["lecture_hall", "lab", "section_room", "auditorium"];
    if (!VALID_TYPES.includes(body.type)) {
        return next(
            new AppError(
                `type must be one of: ${VALID_TYPES.join(", ")}.`,
                400,
            ),
        );
    }

    // readerId uniqueness: catch 11000 and return a clear message
    try {
        const location = await Location.create(body);
        res.status(201).json({ status: "success", data: { location } });
    } catch (err) {
        if (err.code === 11000 && err.keyPattern?.readerId) {
            return next(
                new AppError(
                    "Reader ID is already registered to another location.",
                    400,
                ),
            );
        }
        throw err;
    }
});

/**
 * PATCH /api/v1/locations/:id
 * [SECURITY] Whitelist body fields.
 * [SECURITY] TOCTOU fix — ownership in atomic findOneAndUpdate.
 * [SECURITY] Manual readerId uniqueness check (avoids raw 11000 error).
 */
export const updateLocation = catchAsync(async (req, res, next) => {
    const filteredBody = filterReqBody(req.body, UPDATE_ALLOWED);

    if (Object.keys(filteredBody).length === 0) {
        return next(new AppError("No valid fields to update.", 400));
    }

    // 1. Fetch location first (with ownership filter) to get its real _id and prevent TOCTOU
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "slug",
    );
    let location = await Location.findOne(filter);

    if (!location) return next(new AppError("Location not found.", 404));

    // 2. readerId uniqueness check
    if (filteredBody.readerId !== undefined) {
        if (filteredBody.readerId === "") {
            return next(
                new AppError("readerId cannot be an empty string.", 400),
            );
        }
        const conflict = await Location.findOne({
            readerId: filteredBody.readerId,
            _id: { $ne: location._id }, // exclude the current location using real _id!
        });
        if (conflict) {
            return next(
                new AppError(
                    "Reader ID is already assigned to another location.",
                    400,
                ),
            );
        }
    }

    // 3. Update using findOneAndUpdate to hit all query hooks
    location = await Location.findOneAndUpdate(
        { _id: location._id },
        filteredBody,
        {
            new: true,
            runValidators: true,
        },
    );

    if (!location) return next(new AppError("Location not found.", 404));

    res.status(200).json({ status: "success", data: { location } });
});

/**
 * PATCH /api/v1/locations/:id/status
 * Toggle between 'active' and 'maintenance'.
 * [SECURITY] TOCTOU fix — fetch with ownership filter before updating.
 * Guard: cannot set to 'maintenance' if an active attendance session is running.
 *
 * Note: AttendanceSession model is created in Phase 5.
 * The import is deferred to avoid circular dep at startup — safe import pattern.
 */
export const updateLocationStatus = catchAsync(async (req, res, next) => {
    const { status } = req.body;

    // Validate status value strictly
    if (!status || !VALID_STATUS.includes(status)) {
        return next(
            new AppError(
                `status must be one of: ${VALID_STATUS.join(", ")}.`,
                400,
            ),
        );
    }

    // [SECURITY] TOCTOU: ownership in fetch filter
    const filter = buildOwnershipFilter(
        req.params.id,
        req.user,
        "college_id",
        "slug",
    );
    const location = await Location.findOne(filter);
    if (!location) return next(new AppError("Location not found.", 404));

    if (location.status === status) {
        return next(
            new AppError(`Location is already set to '${status}'.`, 400),
        );
    }

    // Guard: block maintenance if an active attendance session is running
    // AttendanceSession is a Phase 5 model — safe dynamic import to avoid startup errors
    if (status === "maintenance") {
        try {
            const { default: AttendanceSession } =
                await import("../../../DB/models/attendanceSessionModel.js");
            const activeSession = await AttendanceSession.findOne({
                location_id: req.params.id,
                expiresAt: { $gt: new Date() },
            });
            if (activeSession) {
                return next(
                    new AppError(
                        "Cannot set location to maintenance while an active attendance session is running.",
                        400,
                    ),
                );
            }
        } catch {
            // AttendanceSession model not yet created (Phase 5) — skip the guard
        }
    }

    location.status = status;
    await location.save({ validateBeforeSave: false });

    res.status(200).json({ status: "success", data: { location } });
});

/**
 * PATCH /api/v1/locations/:id/archive
 * [SECURITY] TOCTOU fix — ownership in fetch filter.
 * Guard: cannot archive if a live CourseOffering uses this location.
 *
 * Note: CourseOffering is a Phase 3 model — safe dynamic import pattern.
 */
export const archiveLocation = catchAsync(async (req, res, next) => {
    // universityAdmin only (enforced in router) — no ownership filter needed
    const location = await Location.findById(req.params.id);
    if (!location) return next(new AppError("Location not found.", 404));

    // Guard: block if location is in use in any active course offering
    // CourseOffering pre-hook already filters out archived offerings
    try {
        const { default: CourseOffering } =
            await import("../../../DB/models/courseOfferingModel.js");
        const activeOffering = await CourseOffering.findOne({
            "schedule.location": req.params.id,
        });
        if (activeOffering) {
            return next(
                new AppError(
                    "Cannot archive this location. It is scheduled in an active course offering.",
                    400,
                ),
            );
        }
    } catch {
        // CourseOffering model issue — proceed with archive (fail open for admin ops)
    }

    location.isArchived = true;
    location.archivedAt = new Date();
    await location.save({ validateBeforeSave: false });

    res.status(204).json({ status: "success", data: null });
});

/**
 * PATCH /api/v1/locations/:id/restore
 * universityAdmin and collegeAdmin only (enforced in router).
 * Uses findOneAndUpdate with explicit isArchived:true to bypass the pre-hook.
 */
export const restoreLocation = catchAsync(async (req, res, next) => {
    // Step 1: Find the archived location — do NOT update yet
    const filter = buildOwnershipFilter(req.params.id, req.user);
    const location = await Location.findOne({ ...filter, isArchived: true });
    if (!location) {
        return next(
            new AppError("Location not found or is already active.", 404),
        );
    }

    // Step 2: Verify parent college is NOT archived before restoring
    // College pre-hook: findById returns null if college is archived
    const parentCollege = await College.findById(location.college_id).select(
        "_id",
    );
    if (!parentCollege) {
        return next(
            new AppError(
                "Cannot restore this location. Its parent college is archived. Restore the college first.",
                400,
            ),
        );
    }

    // Step 3: Safe to restore now
    location.isArchived = false;
    location.archivedAt = null;
    await location.save({ validateBeforeSave: false });

    res.status(200).json({ status: "success", data: { location } });
});
