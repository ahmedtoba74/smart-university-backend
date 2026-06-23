/**
 * ===================================================================================
 * @file      administrationTools.js
 * @desc      Tier 4 administration tools — loaded for the 'collegeAdmin' role only.
 *            Contains:
 *            - getCollegeOfferings          : All course offerings for the college
 *            - getCollegeUsers              : Users in the college (optional role filter)
 *            - getCollegeEnrollmentStats    : Enrollment counts by offering
 *            - getCollegeDepartments        : Departments in the college
 *            - getCollegeLocations          : Physical locations in the college
 *            - getFingerprintEnrollmentStatus: Students with/without fingerprint templates
 *            All tools use scopeFilter (which contains { college_id: admin.college_id })
 *            injected by attachCollegeScope middleware. collegeAdmin scopeFilter
 *            is always college-scoped — cross-college queries are impossible.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/tools/registry/administrationTools
 */

import mongoose from "mongoose";
import { z } from "zod";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import User from "../../../DB/models/userModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import Department from "../../../DB/models/departmentModel.js";
import Location from "../../../DB/models/locationModel.js";
import FingerprintTemplate from "../../../DB/models/fingerprintTemplateModel.js";

// ===================================================================================
// TOOL: getCollegeOfferings
// ===================================================================================

/**
 * Returns all course offerings for the college admin's college.
 * Uses scopeFilter to ensure college isolation.
 */
const getCollegeOfferings = {
    name: "getCollegeOfferings",
    label: "Checked college course offerings",
    description:
        "Returns all course offerings in the college including assigned doctors, TAs, enrollment counts, and schedule information. Use this when the college admin asks about courses being offered, sections, or course scheduling.",
    schema: z.object({
        semester: z
            .string()
            .optional()
            .describe(
                "Filter by semester (e.g. 'First', 'Second', 'Summer'). Omit to return all semesters.",
            ),
        academicYear: z
            .string()
            .optional()
            .describe(
                "Filter by academic year (e.g. '2025-2026'). Omit to return all years.",
            ),
    }),
    execute: async (input, userContext) => {
        const filter = { ...userContext.scopeFilter };
        if (input.semester) filter.semester = input.semester;
        if (input.academicYear) filter.academicYear = input.academicYear;

        const offerings = await CourseOffering.find(filter)
            .select(
                "course_id semester academicYear doctors_ids tas_ids maxSeats currentEnrolled resultsPublished semesterWorkLocked",
            )
            .populate("course_id", "code title creditHours")
            .lean();

        return JSON.stringify({
            count: offerings.length,
            offerings,
        });
    },
};

// ===================================================================================
// TOOL: getCollegeUsers
// ===================================================================================

/**
 * Returns users in the college admin's college with optional role filtering.
 * Excludes sensitive security fields via explicit .select() projection.
 */
const getCollegeUsers = {
    name: "getCollegeUsers",
    label: "Checked college users",
    description:
        "Returns a list of users (students, doctors, TAs, or administrators) in the college. Can be filtered by role. Use this when the college admin asks about college members, staff, or students.",
    schema: z.object({
        role: z
            .enum(["student", "doctor", "ta", "collegeAdmin", "all"])
            .optional()
            .default("all")
            .describe(
                "Filter by user role. Use 'all' to return users of every role.",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe("Maximum number of users to return (1–50, default 20)."),
    }),
    execute: async (input, userContext) => {
        const filter = { ...userContext.scopeFilter, active: true };
        if (input.role !== "all") {
            filter.role = input.role;
        }

        const users = await User.find(filter)
            .select(
                "name email role department_id level gpa academicStatus photo createdAt",
            )
            .limit(input.limit)
            .lean();

        return JSON.stringify({
            count: users.length,
            users,
        });
    },
};

// ===================================================================================
// TOOL: getCollegeEnrollmentStats
// ===================================================================================

/**
 * Returns enrollment counts by course offering for the college.
 * Groups by offering and status to provide a summary of active/historical enrollments.
 */
const getCollegeEnrollmentStats = {
    name: "getCollegeEnrollmentStats",
    label: "Checked enrollment statistics",
    description:
        "Returns enrollment statistics broken down by course offering in the college. Shows how many students are enrolled, passed, failed, or withdrawn per course. Use this when the college admin asks about enrollment numbers, statistics, or course popularity.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const matchFilter = {};
        if (userContext.scopeFilter?.college_id) {
            matchFilter.college_id = new mongoose.Types.ObjectId(
                userContext.scopeFilter.college_id,
            );
        }

        const stats = await Enrollment.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: {
                        course_id: "$course_id",
                        status: "$status",
                    },
                    courseCode: { $first: "$snapshot.courseCode" },
                    courseTitle: { $first: "$snapshot.courseTitle" },
                    count: { $sum: 1 },
                },
            },
            {
                $group: {
                    _id: "$_id.course_id",
                    courseCode: { $first: "$courseCode" },
                    courseTitle: { $first: "$courseTitle" },
                    statusBreakdown: {
                        $push: {
                            status: "$_id.status",
                            count: "$count",
                        },
                    },
                    totalEnrollments: { $sum: "$count" },
                },
            },
            { $sort: { totalEnrollments: -1 } },
        ]);

        return JSON.stringify({
            count: stats.length,
            stats,
        });
    },
};

// ===================================================================================
// TOOL: getCollegeDepartments
// ===================================================================================

/**
 * Returns all departments within the college admin's college.
 */
const getCollegeDepartments = {
    name: "getCollegeDepartments",
    label: "Checked college departments",
    description:
        "Returns all academic departments in the college including department names and IDs. Use this when the college admin asks about departments, academic units, or organizational structure.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const departments = await Department.find({
            ...userContext.scopeFilter,
        })
            .select("name college_id")
            .lean();

        return JSON.stringify({
            count: departments.length,
            departments,
        });
    },
};

// ===================================================================================
// TOOL: getCollegeLocations
// ===================================================================================

/**
 * Returns all physical locations (halls, labs) belonging to the college admin's college.
 */
const getCollegeLocations = {
    name: "getCollegeLocations",
    label: "Checked college locations",
    description:
        "Returns all physical locations (lecture halls, labs, rooms) in the college. Use this when the college admin asks about available venues, halls, or rooms.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const locations = await Location.find({
            ...userContext.scopeFilter,
        })
            .select("name type capacity college_id")
            .lean();

        return JSON.stringify({
            count: locations.length,
            locations,
        });
    },
};

// ===================================================================================
// TOOL: getFingerprintEnrollmentStatus
// ===================================================================================

/**
 * Returns the fingerprint enrollment status of students in the college.
 * Reports which students have an active biometric template and which do not.
 * Does NOT expose any biometric data (templateData, templateIv, templateAuthTag
 * are excluded by the model's select: false configuration).
 */
const getFingerprintEnrollmentStatus = {
    name: "getFingerprintEnrollmentStatus",
    label: "Checked fingerprint enrollment status",
    description:
        "Returns the fingerprint biometric enrollment status for students in the college. Shows which students have registered their fingerprint and which have not. Use this when the college admin asks about fingerprint enrollment coverage or biometric setup.",
    schema: z.object({}),
    execute: async (_input, userContext) => {
        const [allStudents, enrolledTemplates] = await Promise.all([
            User.find({
                ...userContext.scopeFilter,
                role: "student",
                active: true,
            })
                .select("_id name email")
                .lean(),
            FingerprintTemplate.find({
                ...userContext.scopeFilter,
                isActive: true,
            })
                .select("student_id quality enrolledViaDevice createdAt")
                .lean(),
        ]);

        const enrolledStudentIds = new Set(
            enrolledTemplates.map((t) => t.student_id.toString()),
        );

        const enrolled = [];
        const notEnrolled = [];

        for (const student of allStudents) {
            if (enrolledStudentIds.has(student._id.toString())) {
                enrolled.push(student);
            } else {
                notEnrolled.push(student);
            }
        }

        return JSON.stringify({
            totalStudents: allStudents.length,
            enrolledCount: enrolled.length,
            notEnrolledCount: notEnrolled.length,
            enrolled,
            notEnrolled,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [
    getCollegeOfferings,
    getCollegeUsers,
    getCollegeEnrollmentStats,
    getCollegeDepartments,
    getCollegeLocations,
    getFingerprintEnrollmentStatus,
];
