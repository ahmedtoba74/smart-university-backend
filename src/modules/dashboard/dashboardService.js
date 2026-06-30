/**
 * ===================================================================================
 * @file      dashboardService.js
 * @desc      All read-only DB aggregations for GET /api/v1/dashboard/summary.
 *            Exports three payload builders — one per role group.
 *            IMPORTANT: This file contains ZERO writes and ZERO modifications to
 *            existing models, controllers, or middleware.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Modules/Dashboard/Service
 */

import User from "../../../DB/models/userModel.js";
import College from "../../../DB/models/collegeModel.js";
import Department from "../../../DB/models/departmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import Assessment from "../../../DB/models/assessmentModel.js";
import Submission from "../../../DB/models/submissionModel.js";
import Announcement from "../../../DB/models/announcementModel.js";
import { getSettingsCache } from "../settings/settingsController.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/**
 * Maps our Settings.currentSemester enum values to the frontend's expected strings.
 * No model change needed — mapping handled here in the response layer.
 */
const SEMESTER_LABEL_MAP = {
    First: "fall",
    Second: "spring",
    Summer: "summer",
};

/**
 * Approximate semester duration in days.
 * Used for progress % computation (Option A: % of semester days elapsed).
 */
const SEMESTER_DURATION_DAYS = 120;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Safely executes an async query function, returning `fallback` on any error
 * instead of crashing the entire dashboard payload.
 *
 * @param {Function} fn       - Async function returning the desired value.
 * @param {*}        fallback - Value returned when fn throws.
 * @returns {Promise<*>}
 */
const safe = async (fn, fallback) => {
    try {
        return await fn();
    } catch (err) {
        console.error("[Dashboard] safe query error:", err.message);
        return fallback;
    }
};

/**
 * Computes course progress as the percentage of a ~120-day semester elapsed
 * since the offering was created (Option A: simplest, no per-course logic).
 *
 * @param {Object} offering - CourseOffering Mongoose document.
 * @returns {number} Progress 0–100.
 */
const computeProgress = (offering) => {
    if (!offering?.createdAt) return 0;
    const elapsedDays =
        (Date.now() - new Date(offering.createdAt).getTime()) /
        (1000 * 60 * 60 * 24);
    return Math.min(
        100,
        Math.round((elapsedDays / SEMESTER_DURATION_DAYS) * 100),
    );
};

/**
 * Derives today's class sessions from CourseOffering weekly schedule slots.
 * Constructs ISO 8601 start/end timestamps using today's date + the stored
 * HH:MM time strings (treated as UTC — client handles display timezone).
 *
 * @param {Object[]} offerings - Array of populated CourseOffering documents.
 * @returns {Object[]} todaySchedule array.
 */
const buildTodaySchedule = (offerings) => {
    const todayName = DAY_NAMES[new Date().getDay()];
    const dateStr = new Date().toISOString().substring(0, 10); // YYYY-MM-DD
    const schedule = [];

    for (const offering of offerings) {
        if (!offering) continue;
        const catalogCourse = offering.course_id;
        for (const slot of offering.schedule || []) {
            if (slot.day !== todayName) continue;
            schedule.push({
                start: new Date(
                    `${dateStr}T${slot.startTime}:00.000Z`,
                ).toISOString(),
                end: new Date(
                    `${dateStr}T${slot.endTime}:00.000Z`,
                ).toISOString(),
                courseCode: (catalogCourse?.code || "").toUpperCase(),
                room: slot.location?.name || "TBA",
                type:
                    slot.sessionType === "lecture"
                        ? "Lecture"
                        : slot.sessionType === "lab"
                          ? "Lab"
                          : "Section",
            });
        }
    }
    return schedule;
};

/**
 * Fetches announcements scoped to the given user (Global + College + Department + Course).
 * Reuses the Announcement model query pattern from the existing announcements module —
 * no imports from that module to avoid coupling.
 *
 * NOTE: Announcement model has no `priority` field. The frontend expects it,
 * so we return "medium" as a safe default for all announcements.
 *
 * @param {Object}   user        - req.user (authenticated user document).
 * @param {ObjectId[]} offeringIds - Course offering IDs for "Course" scope.
 * @returns {Promise<Object[]>}
 */
const getAnnouncementsForUser = async (user, offeringIds = []) => {
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
    if (offeringIds.length) {
        orClauses.push({
            "scope.level": "Course",
            "scope.target": { $in: offeringIds },
        });
    }

    const docs = await Announcement.find({ $or: orClauses })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("author_id", "name");

    return docs.map((a) => ({
        id: a._id,
        title: a.title,
        author: a.author_id?.name || "System",
        createdAt: a.createdAt,
        priority: "medium", // Announcement model has no priority field
    }));
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ON MONGOOSE PRE-FIND HOOKS
//
// Models with isArchived pre-find hooks (auto-filter archived docs):
//   College, Department, CourseOffering, Assessment, CourseCatalog, Announcement
//   → .find() / .countDocuments() calls are automatically scoped; no manual filter needed.
//
// User model pre-find hook adds { active: { $ne: false } }:
//   → .find() / .countDocuments() calls are automatically scoped.
//   → But User.aggregate() pipelines bypass hooks → must add manually in $match.
//
// Models with NO archival hook (permanent records):
//   Enrollment, Submission, AttendanceRecord
//   → Query normally; no special handling needed.
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ADMIN PAYLOAD  (universityAdmin | collegeAdmin)
// ═══════════════════════════════════════════════════════════════════════════════

export const buildAdminPayload = async (user) => {
    const isCollegeAdmin = user.role === "collegeAdmin";
    const scopeFilter = isCollegeAdmin ? { college_id: user.college_id } : {};

    // Delta window: users / departments created in the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // ── Stats (all parallel) ──────────────────────────────────────────────────
    const [
        studentsTotal,
        studentsDelta,
        facultyTotal,
        facultyDelta,
        departmentsTotal,
        departmentsDelta,
    ] = await Promise.all([
        safe(() => User.countDocuments({ role: "student", ...scopeFilter }), 0),
        safe(
            () =>
                User.countDocuments({
                    role: "student",
                    ...scopeFilter,
                    createdAt: { $gte: thirtyDaysAgo },
                }),
            0,
        ),
        safe(
            () =>
                User.countDocuments({
                    role: { $in: ["doctor", "ta"] },
                    ...scopeFilter,
                }),
            0,
        ),
        safe(
            () =>
                User.countDocuments({
                    role: { $in: ["doctor", "ta"] },
                    ...scopeFilter,
                    createdAt: { $gte: thirtyDaysAgo },
                }),
            0,
        ),
        safe(() => Department.countDocuments(scopeFilter), 0),
        safe(
            () =>
                Department.countDocuments({
                    ...scopeFilter,
                    createdAt: { $gte: thirtyDaysAgo },
                }),
            0,
        ),
    ]);

    // collegeAdmin always has exactly 1 college
    const [collegesTotal, collegesDelta] = isCollegeAdmin
        ? [1, 0]
        : await Promise.all([
              safe(() => College.countDocuments(), 0),
              safe(
                  () =>
                      College.countDocuments({
                          createdAt: { $gte: thirtyDaysAgo },
                      }),
                  0,
              ),
          ]);

    const stats = {
        students: { total: studentsTotal, delta: studentsDelta },
        faculty: { total: facultyTotal, delta: facultyDelta },
        colleges: { total: collegesTotal, delta: collegesDelta },
        departments: { total: departmentsTotal, delta: departmentsDelta },
    };

    // ── Config — reuse settingsCache (zero extra DB hit if already cached) ────
    const settings = await safe(() => getSettingsCache(), null);
    const config = settings
        ? {
              registrationOpen: settings.isEnrollmentOpen,
              academicYear: settings.currentAcademicYear,
              currentSemester:
                  SEMESTER_LABEL_MAP[settings.currentSemester] ||
                  settings.currentSemester?.toLowerCase() ||
                  null,
              // tuitionStatus has no field in settingsModel.js — hardcoded for now
              tuitionStatus: "collecting",
          }
        : null;

    // ── KPIs — no monitoring stack; activeUsers from lastLoginAt ─────────────
    const activeUsers = await safe(
        () =>
            User.countDocuments({
                lastLoginAt: {
                    $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
                },
                ...scopeFilter,
            }),
        null,
    );

    const kpis = {
        activeUsers,
        systemUptime: null, // No monitoring stack wired
        storageUsed: null,
        cpuUsage: null,
    };

    // ── Charts — all run in parallel ─────────────────────────────────────────
    const collegeAggMatch = isCollegeAdmin
        ? { college_id: user.college_id }
        : {};

    const [
        studentsByCollege,
        roleDistribution,
        topColleges,
        recentActivity,
        enrollmentTrend,
        userGrowth,
    ] = await Promise.all([
        // ── studentsByCollege (PieChart) ──────────────────────────────────────
        safe(async () => {
            return User.aggregate([
                {
                    $match: {
                        role: "student",
                        active: { $ne: false }, // User hook doesn't apply in aggregate
                        ...collegeAggMatch,
                    },
                },
                { $group: { _id: "$college_id", value: { $sum: 1 } } },
                {
                    $lookup: {
                        from: "colleges",
                        localField: "_id",
                        foreignField: "_id",
                        as: "college",
                    },
                },
                {
                    $unwind: {
                        path: "$college",
                        preserveNullAndEmpty: true,
                    },
                },
                {
                    $project: {
                        name: { $ifNull: ["$college.name", "Unknown"] },
                        value: 1,
                        _id: 0,
                    },
                },
                { $sort: { value: -1 } },
            ]);
        }, []),

        // ── roleDistribution (BarChart) ───────────────────────────────────────
        safe(async () => {
            return User.aggregate([
                {
                    $match: {
                        active: { $ne: false },
                        ...collegeAggMatch,
                    },
                },
                { $group: { _id: "$role", value: { $sum: 1 } } },
                {
                    $project: {
                        name: "$_id",
                        value: 1,
                        _id: 0,
                    },
                },
                { $sort: { value: -1 } },
            ]);
        }, []),

        // ── topColleges ───────────────────────────────────────────────────────
        safe(async () => {
            const filter = isCollegeAdmin
                ? { isArchived: false, _id: user.college_id }
                : { isArchived: false };

            return College.aggregate([
                { $match: filter },
                {
                    $lookup: {
                        from: "users",
                        let: { cid: "$_id" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ["$college_id", "$$cid"] },
                                            { $eq: ["$role", "student"] },
                                            { $ne: ["$active", false] },
                                        ],
                                    },
                                },
                            },
                        ],
                        as: "students",
                    },
                },
                {
                    $lookup: {
                        from: "departments",
                        let: { cid: "$_id" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ["$college_id", "$$cid"] },
                                            { $ne: ["$isArchived", true] },
                                        ],
                                    },
                                },
                            },
                        ],
                        as: "depts",
                    },
                },
                {
                    $project: {
                        name: 1,
                        students: { $size: "$students" },
                        departments: { $size: "$depts" },
                        avgGpa: null, // Deferred — heavy join, needs caching strategy
                        _id: 0,
                    },
                },
                { $sort: { students: -1 } },
                { $limit: 10 },
            ]);
        }, []),

        // ── recentActivity — approximate (no AuditLog model exists yet) ───────
        safe(async () => {
            const [recentUsers, recentOfferings] = await Promise.all([
                User.find(scopeFilter)
                    .sort({ createdAt: -1 })
                    .limit(7)
                    .select("name role createdAt"),
                CourseOffering.find(scopeFilter)
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .select("createdAt"),
            ]);

            const activities = [
                ...recentUsers.map((u) => ({
                    id: u._id.toString(),
                    type: "user_created",
                    message: `New ${u.role} account created: ${u.name}`,
                    createdAt: u.createdAt,
                })),
                ...recentOfferings.map((o) => ({
                    id: o._id.toString(),
                    type: "course_added",
                    message: "New course offering created",
                    createdAt: o.createdAt,
                })),
            ]
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, 10);

            return activities;
        }, []),

        // ── enrollmentTrend — total active students by year of registration ───
        safe(async () => {
            return User.aggregate([
                {
                    $match: {
                        role: "student",
                        active: { $ne: false },
                        ...collegeAggMatch,
                    },
                },
                {
                    $group: {
                        _id: { $year: "$createdAt" },
                        students: { $sum: 1 },
                    },
                },
                {
                    $project: {
                        year: { $toString: "$_id" },
                        students: 1,
                        _id: 0,
                    },
                },
                { $sort: { year: 1 } },
            ]);
        }, []),

        // ── userGrowth — per month (LineChart) ───────────────────────────────
        safe(async () => {
            return User.aggregate([
                {
                    $match: {
                        active: { $ne: false },
                        ...collegeAggMatch,
                    },
                },
                {
                    $group: {
                        _id: {
                            year: { $year: "$createdAt" },
                            month: { $month: "$createdAt" },
                        },
                        students: {
                            $sum: {
                                $cond: [{ $eq: ["$role", "student"] }, 1, 0],
                            },
                        },
                        doctors: {
                            $sum: {
                                $cond: [
                                    { $in: ["$role", ["doctor", "ta"]] },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
                { $limit: 12 },
                {
                    $project: {
                        month: {
                            $dateToString: {
                                format: "%b",
                                date: {
                                    $dateFromParts: {
                                        year: "$_id.year",
                                        month: "$_id.month",
                                        day: 1,
                                    },
                                },
                            },
                        },
                        students: 1,
                        doctors: 1,
                        _id: 0,
                    },
                },
            ]);
        }, []),
    ]);

    return {
        stats,
        kpis,
        systemHealth: [], // No monitoring stack — UI hides this card
        systemLoad: [], // No monitoring stack — UI hides this card
        studentsByCollege,
        enrollmentTrend,
        userGrowth,
        roleDistribution,
        topColleges,
        recentActivity,
        config,
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DOCTOR / TA PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════════

export const buildDoctorPayload = async (user) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Find all offerings where this user is a doctor or TA
    // CourseOffering pre-find hook auto-filters isArchived: false
    const myOfferings = await safe(
        () =>
            CourseOffering.find({
                $or: [{ doctors_ids: user._id }, { tas_ids: user._id }],
            })
                .populate("course_id", "title code creditHours")
                .populate({ path: "schedule.location", select: "name" }),
        [],
    );

    const myOfferingIds = myOfferings.map((o) => o._id);

    // ── Stats ─────────────────────────────────────────────────────────────────

    const [studentsTotal, studentsDelta, pendingReviewsTotal, coursesDelta] =
        await Promise.all([
            safe(async () => {
                const ids = await Enrollment.distinct("student_id", {
                    course_id: { $in: myOfferingIds },
                    status: { $ne: "withdrawn" },
                });
                return ids.length;
            }, 0),
            safe(async () => {
                const ids = await Enrollment.distinct("student_id", {
                    course_id: { $in: myOfferingIds },
                    status: { $ne: "withdrawn" },
                    createdAt: { $gte: thirtyDaysAgo },
                });
                return ids.length;
            }, 0),
            safe(
                () =>
                    Submission.countDocuments({
                        courseOffering_id: { $in: myOfferingIds },
                        status: "submitted",
                    }),
                0,
            ),
            safe(
                () =>
                    CourseOffering.countDocuments({
                        $or: [{ doctors_ids: user._id }, { tas_ids: user._id }],
                        createdAt: { $gte: thirtyDaysAgo },
                    }),
                0,
            ),
        ]);

    // Count upcoming classes in the next 7 days from weekly schedule slots
    const upcomingClassesTotal = (() => {
        let count = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
            const dayName = DAY_NAMES[d.getDay()];
            for (const offering of myOfferings) {
                for (const slot of offering.schedule || []) {
                    if (slot.day === dayName) count++;
                }
            }
        }
        return count;
    })();

    const stats = {
        courses: { total: myOfferings.length, delta: coursesDelta },
        students: { total: studentsTotal, delta: studentsDelta },
        pendingReviews: { total: pendingReviewsTotal, delta: 0 },
        upcomingClasses: { total: upcomingClassesTotal, delta: 0 },
    };

    // ── KPIs ──────────────────────────────────────────────────────────────────

    const [avgAttendanceResult, avgGradeResult] = await Promise.all([
        safe(
            () =>
                Enrollment.aggregate([
                    {
                        $match: {
                            course_id: { $in: myOfferingIds },
                            status: { $ne: "withdrawn" },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: "$finalAttendancePercentage" },
                        },
                    },
                ]),
            [],
        ),
        safe(
            () =>
                Enrollment.aggregate([
                    {
                        $match: {
                            course_id: { $in: myOfferingIds },
                            "grades.finalTotal": { $gt: 0 },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: "$grades.finalTotal" },
                        },
                    },
                ]),
            [],
        ),
    ]);

    const avgAttendance =
        avgAttendanceResult[0]?.avg != null
            ? Math.round(avgAttendanceResult[0].avg)
            : null;

    const avgGrade =
        avgGradeResult[0]?.avg != null
            ? Math.round(avgGradeResult[0].avg * 10) / 10
            : null;

    // Submission rate: submitted+graded / (enrolled * total assessments) × 100
    const submissionRate = await safe(async () => {
        if (!myOfferingIds.length) return null;
        const [totalEnrolled, totalSubmissions, totalAssessments] =
            await Promise.all([
                Enrollment.countDocuments({
                    course_id: { $in: myOfferingIds },
                    status: "enrolled",
                }),
                Submission.countDocuments({
                    courseOffering_id: { $in: myOfferingIds },
                    status: { $in: ["submitted", "graded"] },
                }),
                Assessment.countDocuments({
                    courseOffering_id: { $in: myOfferingIds },
                }),
            ]);
        if (!totalEnrolled || !totalAssessments) return null;
        return Math.min(
            100,
            Math.round(
                (totalSubmissions / (totalEnrolled * totalAssessments)) * 100,
            ),
        );
    }, null);

    const kpis = {
        avgAttendance,
        avgGrade,
        submissionRate,
        rating: null, // No course-evaluation feature yet
    };

    // ── All chart/list data in parallel ───────────────────────────────────────

    const [
        gradeDistribution,
        performanceTrend,
        submissionsTrend,
        upcomingAssessments,
        announcements,
        recentActivity,
    ] = await Promise.all([
        // ── gradeDistribution (BarChart) ─────────────────────────────────────
        safe(async () => {
            if (!myOfferingIds.length) return [];
            return Enrollment.aggregate([
                {
                    $match: {
                        course_id: { $in: myOfferingIds },
                        "grades.finalLetter": { $ne: null },
                    },
                },
                { $group: { _id: "$grades.finalLetter", count: { $sum: 1 } } },
                {
                    $project: { grade: "$_id", count: 1, _id: 0 },
                },
                { $sort: { grade: 1 } },
            ]);
        }, []),

        // ── performanceTrend (LineChart — weekly avg grade + attendance) ──────
        safe(async () => {
            if (!myOfferingIds.length) return [];
            return Enrollment.aggregate([
                { $match: { course_id: { $in: myOfferingIds } } },
                {
                    $group: {
                        _id: { week: { $week: "$createdAt" } },
                        avg: { $avg: "$grades.finalTotal" },
                        attendance: { $avg: "$finalAttendancePercentage" },
                    },
                },
                { $sort: { "_id.week": 1 } },
                { $limit: 12 },
                {
                    $project: {
                        week: {
                            $concat: ["W", { $toString: "$_id.week" }],
                        },
                        avg: { $round: ["$avg", 1] },
                        attendance: { $round: ["$attendance", 1] },
                        _id: 0,
                    },
                },
            ]);
        }, []),

        // ── submissionsTrend (AreaChart — on-time vs late per month) ─────────
        safe(async () => {
            if (!myOfferingIds.length) return [];
            return Submission.aggregate([
                {
                    $match: {
                        courseOffering_id: { $in: myOfferingIds },
                        status: { $in: ["submitted", "graded"] },
                        submittedAt: { $exists: true, $ne: null },
                    },
                },
                {
                    $lookup: {
                        from: "assessments",
                        localField: "assessment_id",
                        foreignField: "_id",
                        as: "assessment",
                    },
                },
                {
                    $unwind: {
                        path: "$assessment",
                        preserveNullAndEmpty: true,
                    },
                },
                {
                    $group: {
                        _id: {
                            month: { $month: "$submittedAt" },
                            year: { $year: "$submittedAt" },
                        },
                        onTime: {
                            $sum: {
                                $cond: [
                                    {
                                        $lte: [
                                            "$submittedAt",
                                            "$assessment.dueDate",
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        late: {
                            $sum: {
                                $cond: [
                                    {
                                        $gt: [
                                            "$submittedAt",
                                            "$assessment.dueDate",
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
                { $limit: 6 },
                {
                    $project: {
                        month: {
                            $dateToString: {
                                format: "%b",
                                date: {
                                    $dateFromParts: {
                                        year: "$_id.year",
                                        month: "$_id.month",
                                        day: 1,
                                    },
                                },
                            },
                        },
                        onTime: 1,
                        late: 1,
                        _id: 0,
                    },
                },
            ]);
        }, []),

        // ── upcomingAssessments ───────────────────────────────────────────────
        safe(async () => {
            if (!myOfferingIds.length) return [];

            // Assessment pre-find hook auto-filters isArchived: false
            const assessments = await Assessment.find({
                courseOffering_id: { $in: myOfferingIds },
                dueDate: { $gt: new Date() },
            })
                .sort({ dueDate: 1 })
                .limit(10)
                .select("title courseOffering_id dueDate totalPoints");

            return Promise.all(
                assessments.map(async (a) => {
                    const [submitted, total] = await Promise.all([
                        safe(
                            () =>
                                Submission.countDocuments({
                                    assessment_id: a._id,
                                    status: { $in: ["submitted", "graded"] },
                                }),
                            0,
                        ),
                        safe(
                            () =>
                                Enrollment.countDocuments({
                                    course_id: a.courseOffering_id,
                                    status: "enrolled",
                                }),
                            0,
                        ),
                    ]);
                    const offering = myOfferings.find(
                        (o) =>
                            o._id.toString() === a.courseOffering_id.toString(),
                    );
                    return {
                        id: a._id,
                        title: a.title,
                        course: (offering?.course_id?.code || "").toUpperCase(),
                        dueDate: a.dueDate,
                        points: a.totalPoints,
                        // assessmentModel.js has no type field → safe fallback
                        type: "Assessment",
                        submissions: submitted,
                        total,
                    };
                }),
            );
        }, []),

        // ── announcements ─────────────────────────────────────────────────────
        safe(() => getAnnouncementsForUser(user, myOfferingIds), []),

        // ── recentActivity — approximate from recent graded submissions ───────
        safe(async () => {
            if (!myOfferingIds.length) return [];
            const graded = await Submission.find({
                courseOffering_id: { $in: myOfferingIds },
                status: "graded",
            })
                .sort({ updatedAt: -1 })
                .limit(10)
                .select("courseOffering_id updatedAt");

            return graded.map((s) => {
                const offering = myOfferings.find(
                    (o) => o._id.toString() === s.courseOffering_id.toString(),
                );
                return {
                    id: s._id.toString(),
                    type: "graded",
                    message: `Submission graded for ${(offering?.course_id?.code || "course").toUpperCase()}`,
                    createdAt: s.updatedAt,
                };
            });
        }, []),
    ]);

    // ── myCourses ─────────────────────────────────────────────────────────────
    const myCourses = myOfferings.map((offering) => {
        const catalog = offering.course_id; // populated CourseCatalog
        return {
            code: (catalog?.code || "").toUpperCase(),
            title: catalog?.title || "",
            students: offering.currentEnrolled || 0,
            creditHours: catalog?.creditHours || 0,
            semester: `${offering.semester} ${offering.academicYear}`,
            progress: computeProgress(offering),
        };
    });

    return {
        stats,
        kpis,
        todaySchedule: buildTodaySchedule(myOfferings),
        recentActivity,
        performanceTrend,
        // assessmentDistribution requires a `type` field on Assessment model
        // which doesn't exist. Returning [] so the UI shows an empty state.
        assessmentDistribution: [],
        gradeDistribution,
        submissionsTrend,
        myCourses,
        upcomingAssessments,
        announcements,
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. STUDENT PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════════

export const buildStudentPayload = async (user) => {
    const settings = await safe(() => getSettingsCache(), null);

    // Active enrollments with nested populate:
    //   course_id         → CourseOffering
    //   course_id.course_id → CourseCatalog (title, code, creditHours)
    // CourseOffering pre-find hook auto-filters isArchived: false
    const activeEnrollments = await safe(
        () =>
            Enrollment.find({
                student_id: user._id,
                status: "enrolled",
            }).populate({
                path: "course_id",
                populate: [
                    { path: "course_id", select: "title code creditHours" },
                    { path: "schedule.location", select: "name" },
                ],
            }),
        [],
    );

    // Extract offering ObjectIds for downstream queries
    const myOfferingIds = activeEnrollments
        .map((e) => e.course_id?._id || e.course_id)
        .filter(Boolean);

    // ── Stats ─────────────────────────────────────────────────────────────────

    // GPA, earnedCredits, level, and academicStatus are select:false in userModel.
    // protect middleware does not include them in req.user, so we re-fetch them here
    // with an explicit +select. This keeps the dashboard self-contained and correct
    // regardless of what the auth middleware chooses to load.
    const studentAcademicData = await safe(
        () =>
            User.findById(user._id).select(
                "+gpa +earnedCredits +level +academicStatus",
            ),
        null,
    );
    const currentGpa = studentAcademicData?.gpa || 0;

    // Credits
    const currentCredits = activeEnrollments.reduce(
        (sum, e) =>
            sum +
            (e.snapshot?.creditHours ||
                e.course_id?.course_id?.creditHours ||
                0),
        0,
    );
    const earnedCredits = studentAcademicData?.earnedCredits || 0;
    // Required credits from settings levelThresholds level 5 (graduation threshold)
    const requiredCredits =
        settings?.levelThresholds?.get(5) ||
        settings?.levelThresholds?.get("5") ||
        120;

    // Attendance average across enrolled courses
    const attendanceResult = await safe(
        () =>
            Enrollment.aggregate([
                { $match: { student_id: user._id, status: "enrolled" } },
                {
                    $group: {
                        _id: null,
                        avg: { $avg: "$finalAttendancePercentage" },
                    },
                },
            ]),
        [],
    );
    const attendanceValue =
        attendanceResult[0]?.avg != null
            ? Math.round(attendanceResult[0].avg * 10) / 10
            : 0;

    // Assignments: completed (graded submissions) + pending (upcoming not submitted)
    const [completedAssignments, pendingAssignments] = await Promise.all([
        safe(
            () =>
                Submission.countDocuments({
                    student_id: user._id,
                    status: "graded",
                }),
            0,
        ),
        safe(async () => {
            if (!myOfferingIds.length) return 0;
            // Find assessment IDs already submitted by this student
            const submittedIds = (
                await Submission.find({
                    student_id: user._id,
                    status: { $in: ["submitted", "graded"] },
                }).select("assessment_id")
            ).map((s) => s.assessment_id);

            return Assessment.countDocuments({
                courseOffering_id: { $in: myOfferingIds },
                dueDate: { $gt: new Date() },
                _id: { $nin: submittedIds },
            });
        }, 0),
    ]);

    const stats = {
        gpa: { value: currentGpa, delta: 0 },
        credits: {
            earned: earnedCredits,
            required: requiredCredits,
            current: currentCredits,
            delta: currentCredits,
        },
        attendance: { value: attendanceValue, delta: 0 },
        rank: null, // Cohort definition not decided — UI hides when null
        assignments: {
            completed: completedAssignments,
            pending: pendingAssignments,
        },
        streak: null, // No engagement tracking yet — UI hides when null
    };

    // ── Charts + Lists — all parallel ─────────────────────────────────────────

    const [
        gpaTrend,
        gradeDistribution,
        creditsByYear,
        upcomingAssessments,
        announcements,
    ] = await Promise.all([
        // ── gpaTrend (LineChart — per semester) ──────────────────────────────
        safe(async () => {
            // Approximate GPA per semester from finalTotal (0–100 → /25 → 0–4.0 scale)
            return Enrollment.aggregate([
                {
                    $match: {
                        student_id: user._id,
                        status: { $in: ["passed", "failed"] },
                        "grades.finalTotal": { $gt: 0 },
                    },
                },
                {
                    $group: {
                        _id: {
                            academicYear: "$academicYear",
                            semester: "$semester",
                        },
                        avgScore: { $avg: "$grades.finalTotal" },
                    },
                },
                { $sort: { "_id.academicYear": 1 } },
                {
                    $project: {
                        semester: {
                            $concat: [
                                { $substr: ["$_id.academicYear", 0, 4] },
                                "-",
                                { $substr: ["$_id.semester", 0, 2] },
                            ],
                        },
                        // Normalize 0-100 score to 0-4.0 GPA approximation
                        gpa: {
                            $round: [{ $divide: ["$avgScore", 25] }, 2],
                        },
                        _id: 0,
                    },
                },
            ]);
        }, []),

        // ── gradeDistribution (PieChart — letter grade histogram) ────────────
        safe(async () => {
            return Enrollment.aggregate([
                {
                    $match: {
                        student_id: user._id,
                        "grades.finalLetter": { $ne: null },
                    },
                },
                { $group: { _id: "$grades.finalLetter", value: { $sum: 1 } } },
                {
                    $project: { name: "$_id", value: 1, _id: 0 },
                },
            ]);
        }, []),

        // ── creditsByYear (BarChart) ──────────────────────────────────────────
        safe(async () => {
            return Enrollment.aggregate([
                {
                    $match: {
                        student_id: user._id,
                        status: { $in: ["passed", "failed"] },
                    },
                },
                {
                    $group: {
                        _id: "$academicYear",
                        completed: {
                            $sum: {
                                $cond: [
                                    { $eq: ["$status", "passed"] },
                                    { $ifNull: ["$snapshot.creditHours", 0] },
                                    0,
                                ],
                            },
                        },
                        total: {
                            $sum: { $ifNull: ["$snapshot.creditHours", 0] },
                        },
                    },
                },
                { $sort: { _id: 1 } },
                {
                    $project: {
                        year: "$_id",
                        completed: 1,
                        total: 1,
                        _id: 0,
                    },
                },
            ]);
        }, []),

        // ── upcomingAssessments ───────────────────────────────────────────────
        safe(async () => {
            if (!myOfferingIds.length) return [];

            const assessments = await Assessment.find({
                courseOffering_id: { $in: myOfferingIds },
                dueDate: { $gt: new Date() },
            })
                .sort({ dueDate: 1 })
                .limit(10)
                .select("title courseOffering_id dueDate totalPoints");

            return Promise.all(
                assessments.map(async (a) => {
                    const submission = await safe(
                        () =>
                            Submission.findOne({
                                assessment_id: a._id,
                                student_id: user._id,
                            }).select("status"),
                        null,
                    );
                    const enrollment = activeEnrollments.find((e) => {
                        const oid =
                            e.course_id?._id?.toString() ||
                            e.course_id?.toString();
                        return oid === a.courseOffering_id.toString();
                    });
                    return {
                        id: a._id,
                        offeringId: a.courseOffering_id,
                        title: a.title,
                        course: (
                            enrollment?.snapshot?.courseCode || ""
                        ).toUpperCase(),
                        dueDate: a.dueDate,
                        points: a.totalPoints,
                        type: "Assessment", // assessmentModel has no type field
                        submitted:
                            !!submission && submission.status !== "in_progress",
                    };
                }),
            );
        }, []),

        // ── announcements ─────────────────────────────────────────────────────
        safe(() => getAnnouncementsForUser(user, myOfferingIds), []),
    ]);

    // ── myCourses ─────────────────────────────────────────────────────────────
    const myCourses = await safe(async () => {
        return Promise.all(
            activeEnrollments.map(async (enr) => {
                const offering = enr.course_id; // CourseOffering
                const catalog = offering?.course_id; // CourseCatalog

                // Fetch primary doctor name for this offering
                let doctorName = "";
                if (offering?.doctors_ids?.length) {
                    const doctor = await safe(
                        () =>
                            User.findById(offering.doctors_ids[0]).select(
                                "name",
                            ),
                        null,
                    );
                    if (doctor) doctorName = `Dr. ${doctor.name}`;
                }

                return {
                    code: (
                        catalog?.code ||
                        enr.snapshot?.courseCode ||
                        ""
                    ).toUpperCase(),
                    title: catalog?.title || enr.snapshot?.courseTitle || "",
                    doctor: doctorName,
                    credits:
                        catalog?.creditHours || enr.snapshot?.creditHours || 0,
                    attendance: enr.finalAttendancePercentage || 0,
                    grade: enr.grades?.finalLetter || null,
                    gradePct:
                        enr.grades?.finalTotal > 0
                            ? enr.grades.finalTotal
                            : null,
                    progress: computeProgress(offering),
                };
            }),
        );
    }, []);

    // Extract the offering documents for todaySchedule derivation
    const offeringDocs = activeEnrollments
        .map((e) => e.course_id)
        .filter(Boolean);

    return {
        stats,
        achievements: [], // No gamification system yet — UI shows empty state
        todaySchedule: buildTodaySchedule(offeringDocs),
        announcements,
        gpaTrend,
        gradeDistribution,
        creditsByYear,
        studyHours: [], // No time-tracking yet — UI shows empty state
        myCourses,
        upcomingAssessments,
    };
};
