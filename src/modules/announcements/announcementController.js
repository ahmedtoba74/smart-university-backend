import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import Announcement from "../../../DB/models/announcementModel.js";
import Department from "../../../DB/models/departmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import APIFeatures from "../../utils/apiFeatures.js";
import {
    applyIsArchivedGuard,
    applyFieldsGuard,
} from "../../utils/controllerUtils.js";
import { broadcastAnnouncement } from "../../services/socketService.js";
import { logAuditEvent } from "../../utils/auditLogger.js";

// ===========================================
// INTERNAL HELPER — VISIBILITY FILTER BUILDER
// ===========================================

/**
 * Builds the role-specific MongoDB visibility filter for a given user.
 * Called by getAnnouncements, getAnnouncementById, and deleteAnnouncement.
 * Centralizing this logic prevents drift across the three endpoints.
 *
 * Security notes:
 * - collegeAdmin: Both Department and CourseOffering sub-queries bypass the
 *   isArchived pre-find hook to include historical announcements for moderation.
 * - doctor/ta: CourseOffering sub-query bypasses isArchived to include historical
 *   course announcements from past semesters.
 * - student/doctor/ta: College and Department $or clauses are only added when the
 *   corresponding field exists on req.user (guards against null casting).
 *
 * @param {Object} user - req.user (Mongoose document)
 * @returns {Promise<Object>} MongoDB query filter
 */
const buildVisibilityFilter = async (user) => {
    // University admin sees everything
    if (user.role === "universityAdmin") {
        return {};
    }

    if (user.role === "collegeAdmin") {
        // Bypass pre-find hook on both queries to include archived entities.
        // A collegeAdmin must be able to moderate historical announcements
        // even after a department or course offering has been archived.
        const [depts, offerings] = await Promise.all([
            Department.find({
                college_id: user.college_id,
                isArchived: { $in: [true, false] },
            })
                .select("_id")
                .lean(),
            CourseOffering.find({
                college_id: user.college_id,
                isArchived: { $in: [true, false] },
            })
                .select("_id")
                .lean(),
        ]);

        const deptIds = depts.map((d) => d._id);
        const offeringIds = offerings.map((o) => o._id);

        return {
            $or: [
                { "scope.level": "Global" },
                { "scope.level": "College", "scope.target": user.college_id },
                {
                    "scope.level": "Department",
                    "scope.target": { $in: deptIds },
                },
                {
                    "scope.level": "Course",
                    "scope.target": { $in: offeringIds },
                },
            ],
        };
    }

    if (user.role === "student") {
        const enrollments = await Enrollment.find({
            student_id: user._id,
            // Include active and historical enrollments so students can access
            // announcements from courses they have already completed or failed.
            status: { $in: ["enrolled", "passed", "failed"] },
        })
            .select("course_id")
            .lean();

        const enrolledOfferingIds = enrollments.map((e) => e.course_id);

        // Build $or dynamically — only add college/dept clauses if fields exist
        const orClauses = [{ "scope.level": "Global" }];
        if (user.college_id) {
            orClauses.push({
                "scope.level": "College",
                "scope.target": user.college_id,
            });
        }
        if (user.department_id) {
            orClauses.push({
                "scope.level": "Department",
                "scope.target": user.department_id,
            });
        }
        orClauses.push({
            "scope.level": "Course",
            "scope.target": { $in: enrolledOfferingIds },
        });

        return { $or: orClauses };
    }

    if (user.role === "doctor" || user.role === "ta") {
        // Bypass pre-find hook to include archived offerings.
        // A teacher should still see their historical course announcements
        // even after a semester ends and the offering is archived.
        const offerings = await CourseOffering.find({
            isArchived: { $in: [true, false] },
            $or: [{ doctors_ids: user._id }, { tas_ids: user._id }],
        })
            .select("_id")
            .lean();

        const assignedOfferingIds = offerings.map((o) => o._id);

        // Build $or dynamically
        const orClauses = [{ "scope.level": "Global" }];
        if (user.college_id) {
            orClauses.push({
                "scope.level": "College",
                "scope.target": user.college_id,
            });
        }
        if (user.department_id) {
            orClauses.push({
                "scope.level": "Department",
                "scope.target": user.department_id,
            });
        }
        orClauses.push({
            "scope.level": "Course",
            "scope.target": { $in: assignedOfferingIds },
        });

        return { $or: orClauses };
    }

    // Safety net: unknown role sees nothing
    return { _id: null };
};

// ===========================================
// RESPONSE TRANSFORMER
// ===========================================

/**
 * Transforms a populated Announcement document for the REST API response.
 * Renames the populated 'author_id' field to 'author' so the REST shape
 * matches the WebSocket 'new_announcement' payload consistently.
 *
 * If 'author_id' was not populated (e.g. excluded by a ?fields projection),
 * the document is returned as-is without modification.
 *
 * IMPORTANT: Do NOT use this in deleteAnnouncement — that handler must compare
 * announcement.author_id as an ObjectId, not a populated subdocument.
 *
 * @param {Object} doc - Mongoose document (has .toObject()) or plain object
 * @returns {Object} Plain object with author field instead of author_id
 */
const toAnnouncementResponse = (doc) => {
    const obj = doc.toObject ? doc.toObject() : { ...doc };
    // Only rename when author_id is a populated subdocument (has .name set)
    if (
        obj.author_id &&
        typeof obj.author_id === "object" &&
        obj.author_id.name !== undefined
    ) {
        obj.author = obj.author_id;
        delete obj.author_id;
    }
    return obj;
};

// ===========================================
// CONTROLLERS
// ===========================================

/**
 * POST /api/v1/announcements
 * Create a scoped announcement with role-based tenant boundary enforcement.
 * Triggers a fire-and-forget WebSocket broadcast after successful DB write.
 */
export const createAnnouncement = catchAsync(async (req, res, next) => {
    const { title, content, scope, expiresAt } = req.body;

    // --- 1. INPUT VALIDATION ---
    // Guard against missing or malformed scope before any ObjectId operations
    if (!scope || !scope.level || !Array.isArray(scope.target)) {
        return next(
            new AppError(
                "scope.level (string) and scope.target (array) are required.",
                400,
            ),
        );
    }

    // Validate optional expiresAt — must be a valid future date if provided
    let parsedExpiresAt;
    if (expiresAt !== undefined) {
        parsedExpiresAt = new Date(expiresAt);
        if (isNaN(parsedExpiresAt.getTime())) {
            return next(
                new AppError(
                    "expiresAt must be a valid ISO 8601 date string.",
                    400,
                ),
            );
        }
        if (parsedExpiresAt <= new Date()) {
            return next(new AppError("expiresAt must be a future date.", 400));
        }
    }

    const { level } = scope;
    const target = scope.target;
    let uniqueTargets; // Will hold the validated, deduplicated target array

    // --- 2. AUTHORIZATION & TENANT BOUNDARY CHECKS ---
    // All ObjectId comparisons use .equals() or .toString() — never ===

    if (level === "Global") {
        if (req.user.role !== "universityAdmin") {
            return next(
                new AppError(
                    "Only university admins can publish global announcements.",
                    403,
                ),
            );
        }
        // Always override to empty array — never trust client-supplied targets for Global scope
        uniqueTargets = [];
    } else if (level === "College") {
        if (!["universityAdmin", "collegeAdmin"].includes(req.user.role)) {
            return next(
                new AppError(
                    "Only university or college admins can publish college announcements.",
                    403,
                ),
            );
        }
        if (target.length !== 1) {
            return next(
                new AppError(
                    "College announcements must target exactly one college.",
                    400,
                ),
            );
        }
        // collegeAdmin: target must be their own college
        // universityAdmin: can target any college — no ownership restriction
        if (
            req.user.role === "collegeAdmin" &&
            !req.user.college_id.equals(target[0])
        ) {
            return next(
                new AppError("Target college must be your own college.", 403),
            );
        }
        uniqueTargets = [target[0]];
    } else if (level === "Department") {
        if (!["universityAdmin", "collegeAdmin"].includes(req.user.role)) {
            return next(
                new AppError(
                    "Only university or college admins can publish department announcements.",
                    403,
                ),
            );
        }
        // Deduplicate before length validation to prevent spurious 403 on duplicate input
        uniqueTargets = [...new Set(target.map((t) => t.toString()))];

        if (req.user.role === "collegeAdmin") {
            // collegeAdmin: all targets must belong to their own college
            // No archived bypass — cannot post new announcements to archived departments
            const depts = await Department.find({
                _id: { $in: uniqueTargets },
                college_id: req.user.college_id,
            })
                .select("_id")
                .lean();

            if (depts.length !== uniqueTargets.length) {
                return next(
                    new AppError(
                        "One or more departments do not belong to your college.",
                        403,
                    ),
                );
            }
        } else {
            // universityAdmin: verify all department IDs exist (any college)
            const depts = await Department.find({
                _id: { $in: uniqueTargets },
            })
                .select("_id")
                .lean();

            if (depts.length !== uniqueTargets.length) {
                return next(
                    new AppError(
                        "One or more department IDs are invalid.",
                        400,
                    ),
                );
            }
        }
    } else if (level === "Course") {
        if (
            !["universityAdmin", "collegeAdmin", "doctor", "ta"].includes(
                req.user.role,
            )
        ) {
            return next(
                new AppError(
                    "You are not authorized to publish course announcements.",
                    403,
                ),
            );
        }
        // Deduplicate before length validation
        uniqueTargets = [...new Set(target.map((t) => t.toString()))];

        if (req.user.role === "collegeAdmin") {
            // collegeAdmin: all targets must belong to their own college
            // No archived bypass — cannot post new announcements to archived courses
            const offerings = await CourseOffering.find({
                _id: { $in: uniqueTargets },
                college_id: req.user.college_id,
            })
                .select("_id")
                .lean();

            if (offerings.length !== uniqueTargets.length) {
                return next(
                    new AppError(
                        "One or more course offerings do not belong to your college.",
                        403,
                    ),
                );
            }
        } else if (req.user.role === "doctor" || req.user.role === "ta") {
            // doctor/ta: must be assigned to the targeted offerings
            const offerings = await CourseOffering.find({
                _id: { $in: uniqueTargets },
                $or: [{ doctors_ids: req.user._id }, { tas_ids: req.user._id }],
            })
                .select("_id")
                .lean();

            if (offerings.length !== uniqueTargets.length) {
                return next(
                    new AppError(
                        "You are not assigned to one or more selected course offerings.",
                        403,
                    ),
                );
            }
        } else {
            // universityAdmin: verify all course offering IDs exist (any college)
            const offerings = await CourseOffering.find({
                _id: { $in: uniqueTargets },
            })
                .select("_id")
                .lean();

            if (offerings.length !== uniqueTargets.length) {
                return next(
                    new AppError(
                        "One or more course offering IDs are invalid.",
                        400,
                    ),
                );
            }
        }
    } else {
        return next(new AppError("Invalid scope.level value.", 400));
    }

    // --- 3. CREATE RECORD ---
    // Always save uniqueTargets (deduplicated and validated) — never raw client input
    const announcement = await Announcement.create({
        title,
        content,
        author_id: req.user._id,
        scope: { level, target: uniqueTargets },
        // expiresAt is undefined when not provided — Mongoose treats undefined as omitted
        // so the schema default (null) is applied automatically
        ...(parsedExpiresAt !== undefined && { expiresAt: parsedExpiresAt }),
    });

    // Populate author for response consistency with the WebSocket payload shape
    await announcement.populate("author_id", "name role");

    // --- 4. AUDIT LOG ---
    logAuditEvent({
        actor: req.user,
        action: "ANNOUNCEMENT_CREATED",
        resource: "Announcement",
        resourceId: announcement._id,
        ip: req.ip,
        details: {
            scope: { level, target: uniqueTargets },
            title,
            expiresAt: parsedExpiresAt ?? null,
        },
    });

    // --- 5. FIRE-AND-FORGET BROADCAST ---
    // broadcastAnnouncement is async. A try/catch here would NOT catch its rejections.
    // The .catch() pattern absorbs async rejections without blocking the HTTP response.
    broadcastAnnouncement(announcement).catch((broadcastErr) => {
        console.error(
            "[Broadcast] Failed to emit announcement:",
            broadcastErr.message,
        );
    });

    // --- 6. HTTP RESPONSE ---
    res.status(201).json({
        status: "success",
        data: { announcement: toAnnouncementResponse(announcement) },
    });
});

// ─────────────────────────────────────────────

/**
 * GET /api/v1/announcements
 * Returns paginated, filtered announcements visible to the requesting user.
 * Supports all APIFeatures query params: sort, fields, page, limit, isArchived.
 */
export const getAnnouncements = catchAsync(async (req, res, next) => {
    // Guard against attempts to select protected fields via ?fields=
    if (!applyFieldsGuard(req, next)) return;

    // Populate req.archivedFilter based on ?isArchived query param and user role
    if (!applyIsArchivedGuard(req, next)) return;

    // Build role-specific visibility filter
    const Filter = await buildVisibilityFilter(req.user);

    // Merge visibility filter with archived filter
    // Manual merge is necessary because Filter contains complex $or operations
    // that cannot be passed directly as a scopeFilter to APIFeatures.
    const combinedFilter = { ...Filter, ...req.archivedFilter };

    const features = new APIFeatures(
        Announcement.find(combinedFilter),
        req.query,
    )
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const [rawAnnouncements, total] = await Promise.all([
        features.query.populate("author_id", "name role"),
        features.countTotal(Announcement, combinedFilter),
    ]);

    const announcements = rawAnnouncements.map(toAnnouncementResponse);

    res.status(200).json({
        status: "success",
        results: announcements.length,
        total,
        page: features.page,
        limit: features.limit,
        data: { announcements },
    });
});

// ─────────────────────────────────────────────

/**
 * GET /api/v1/announcements/:id
 * Returns a single announcement if it exists within the user's visibility boundary.
 * Visibility check is folded into the DB query — prevents 403-vs-404 probing.
 */
export const getAnnouncementById = catchAsync(async (req, res, next) => {
    const Filter = await buildVisibilityFilter(req.user);

    // Admins (UA/CA) can retrieve archived announcements by ID for audit and investigation.
    // Setting isArchived explicitly in the filter bypasses the pre-find hook which
    // otherwise unconditionally adds { isArchived: false } when the field is absent.
    // Non-admin roles always see only active announcements (hook default applies).
    const isAdminRole = ["universityAdmin", "collegeAdmin"].includes(
        req.user.role,
    );
    if (isAdminRole) {
        Filter.isArchived = { $in: [true, false] };
    }

    // Single query: fetch only if within visibility boundary.
    // Returns 404 for both non-existent AND out-of-scope documents (probing resistance).
    const announcement = await Announcement.findOne({
        _id: req.params.id,
        ...Filter,
    }).populate("author_id", "name role");

    if (!announcement) {
        return next(new AppError("Announcement not found.", 404));
    }

    res.status(200).json({
        status: "success",
        data: { announcement: toAnnouncementResponse(announcement) },
    });
});

// ─────────────────────────────────────────────

/**
 * DELETE /api/v1/announcements/:id
 * Soft-deletes (isArchived = true) an announcement.
 *
 * Authorization policy (Option B — college-scoped moderation):
 * - The author can always delete their own announcements.
 * - universityAdmin can delete any announcement.
 * - collegeAdmin can delete announcements scoped entirely within their college,
 *   even if they are not the author. Validated via DB query, not just scope field.
 *   isArchived bypass applied to dept/course validation to prevent false 403
 *   when targets have been archived since the announcement was posted.
 */
export const deleteAnnouncement = catchAsync(async (req, res, next) => {
    // --- 1. BUILD VISIBILITY FILTER ---
    const Filter = await buildVisibilityFilter(req.user);

    // --- 2. FETCH WITHIN VISIBILITY BOUNDARY ---
    // Baking the filter into the query prevents 403-vs-404 information leakage.
    // Pre-find hook auto-excludes archived docs — already-deleted announcements return 404.
    const announcement = await Announcement.findOne({
        _id: req.params.id,
        ...Filter,
    });

    if (!announcement) {
        return next(new AppError("Announcement not found.", 404));
    }

    const { scope } = announcement;

    // --- 3. AUTHORIZATION CHECK ---

    // Allow: author deleting their own announcement
    const isAuthor =
        announcement.author_id.toString() === req.user._id.toString();

    // Allow: university admin can delete anything
    const isUniversityAdmin = req.user.role === "universityAdmin";

    // Allow: college admin moderating announcements within their college
    let isCollegeAdminAuthorized = false;
    if (req.user.role === "collegeAdmin") {
        if (scope.level === "College") {
            // College scope: verify target is the admin's own college
            isCollegeAdminAuthorized = req.user.college_id.equals(
                scope.target[0],
            );
        } else if (scope.level === "Department") {
            // Department scope: verify all targets belong to the admin's college.
            // Bypass pre-find hook — targets may have been archived since announcement was posted.
            const uniqueTargets = [
                ...new Set(scope.target.map((t) => t.toString())),
            ];
            const count = await Department.countDocuments({
                _id: { $in: uniqueTargets },
                college_id: req.user.college_id,
                isArchived: { $in: [true, false] },
            });
            isCollegeAdminAuthorized = count === uniqueTargets.length;
        } else if (scope.level === "Course") {
            // Course scope: verify all targets belong to the admin's college.
            // Bypass pre-find hook — offerings may have been archived since announcement was posted.
            const uniqueTargets = [
                ...new Set(scope.target.map((t) => t.toString())),
            ];
            const count = await CourseOffering.countDocuments({
                _id: { $in: uniqueTargets },
                college_id: req.user.college_id,
                isArchived: { $in: [true, false] },
            });
            isCollegeAdminAuthorized = count === uniqueTargets.length;
        }
        // Global scope: collegeAdmin cannot delete global announcements
    }

    if (!isAuthor && !isUniversityAdmin && !isCollegeAdminAuthorized) {
        return next(
            new AppError(
                "You are not authorized to delete this announcement.",
                403,
            ),
        );
    }

    // --- 4. SOFT-DELETE ---
    announcement.isArchived = true;
    await announcement.save();

    // --- 5. AUDIT LOG ---
    logAuditEvent({
        actor: req.user,
        action: "ANNOUNCEMENT_DELETED",
        resource: "Announcement",
        resourceId: announcement._id,
        ip: req.ip,
        details: {
            scope: announcement.scope,
            deletedBy: req.user.role,
            // wasAuthor: true means the actor deleted their own announcement
            // wasAuthor: false means a UA/CA used moderation authority
            wasAuthor: isAuthor,
        },
    });

    // --- 6. RESPONSE ---
    res.status(204).json({ status: "success", data: null });
});
