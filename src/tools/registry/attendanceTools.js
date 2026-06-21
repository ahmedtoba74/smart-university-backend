/**
 * ===================================================================================
 * @file      attendanceTools.js
 * @desc      Attendance tools — loaded for 'student', 'doctor', and 'ta' roles.
 *
 *            Provides two perspectives on attendance data:
 *              - getMyAttendance    : Student's own attendance for a specific course
 *              - getSessionReport   : Doctor/TA present/absent breakdown for a session
 *
 *            Both tools enforce strict IDOR boundaries:
 *              - getMyAttendance uses student_id: userContext.user._id
 *              - getSessionReport verifies the doctor/TA is assigned to the offering
 *                before returning session data
 *
 * @module    src/tools/registry/attendanceTools
 * @requires  zod
 * @requires  ../../../DB/models/attendanceRecordModel
 * @requires  ../../../DB/models/attendanceSessionModel
 * @requires  ../../../DB/models/enrollmentModel
 * @requires  ../../../DB/models/courseOfferingModel
 * ===================================================================================
 */

import { z } from "zod";
import { objectIdSchema } from "../../utils/validationUtils.js";
import AttendanceRecord from "../../../DB/models/attendanceRecordModel.js";
import AttendanceSession from "../../../DB/models/attendanceSessionModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";

// ===================================================================================
// TOOL: getMyAttendance  (Student)
// ===================================================================================

/**
 * Returns attendance records for a specific course offering that the student
 * is enrolled in. Includes per-session present/absent status and an aggregate summary.
 *
 * IDOR: Verifies the student is enrolled in the offering (student_id ownership).
 *       Queries AttendanceRecord by student_id — no cross-student data access.
 */
const getMyAttendance = {
    name: "getMyAttendance",
    label: "Checked your attendance",
    description:
        "Returns attendance records for the student in a specific course offering. Shows each session's date and status (present/absent) and provides an attendance percentage summary. Use this when the student asks about their attendance in a course, how many sessions they attended, or their attendance percentage.",
    schema: z.object({
        courseOfferingId: objectIdSchema.describe(
            "The MongoDB ObjectId of the course offering to check attendance for.",
        ),
    }),
    execute: async (input, userContext) => {
        // Verify enrollment (IDOR: must be enrolled before seeing attendance)
        const enrollment = await Enrollment.findOne({
            student_id: userContext.user._id,
            course_id: input.courseOfferingId,
        })
            .select("finalAttendancePercentage snapshot")
            .lean();

        if (!enrollment) {
            return JSON.stringify({
                error: "You are not enrolled in this course offering.",
            });
        }

        // Fetch all sessions for the offering to compute total
        const [records, allSessions] = await Promise.all([
            AttendanceRecord.find({
                student_id: userContext.user._id,
                courseOffering_id: input.courseOfferingId,
            })
                .select("session_id timestamp source")
                .populate("session_id", "startTime expiresAt status")
                .sort({ timestamp: -1 })
                .lean(),
            AttendanceSession.find({
                courseOffering_id: input.courseOfferingId,
                status: { $in: ["expired", "ended"] },
            })
                .select("_id startTime status")
                .lean(),
        ]);

        const attendedSessionIds = new Set(
            records.map((r) => r.session_id?._id?.toString()),
        );

        // Annotate each session with present/absent
        const sessions = allSessions.map((s) => ({
            sessionId: s._id,
            startTime: s.startTime,
            status: attendedSessionIds.has(s._id.toString())
                ? "present"
                : "absent",
        }));

        return JSON.stringify({
            courseSnapshot: enrollment.snapshot,
            totalSessions: allSessions.length,
            attended: records.length,
            attendancePercentage: enrollment.finalAttendancePercentage,
            sessions,
        });
    },
};

// ===================================================================================
// TOOL: getSessionReport  (Doctor / TA)
// ===================================================================================

/**
 * Returns the present/absent breakdown for a specific attendance session.
 *
 * IDOR: Verifies the doctor/TA is assigned to the offering (doctors_ids or tas_ids)
 *       before returning any data. Cross-offering data access is prevented.
 */
const getSessionReport = {
    name: "getSessionReport",
    label: "Checked the attendance session report",
    description:
        "Returns a detailed attendance report for a specific session, listing which students were present and which were absent. Use this when the doctor or TA wants to see who attended a particular class session.",
    schema: z.object({
        sessionId: objectIdSchema.describe(
            "The MongoDB ObjectId of the attendance session.",
        ),
    }),
    execute: async (input, userContext) => {
        const session = await AttendanceSession.findById(input.sessionId)
            .select("courseOffering_id startTime status")
            .lean();

        if (!session) {
            return JSON.stringify({ error: "Session not found." });
        }

        // IDOR: verify the requesting doctor/TA is assigned to this offering
        const offering = await CourseOffering.findOne({
            _id: session.courseOffering_id,
            $or: [
                { doctors_ids: userContext.user._id },
                { tas_ids: userContext.user._id },
            ],
        })
            .select("_id")
            .lean();

        if (!offering) {
            return JSON.stringify({
                error: "You are not authorized to view this session.",
            });
        }

        // Get all enrolled students for the offering
        const enrollments = await Enrollment.find({
            course_id: session.courseOffering_id,
            status: { $ne: "withdrawn" },
        })
            .select("student_id snapshot")
            .populate("student_id", "name email")
            .lean();

        // Get present student IDs from records
        const records = await AttendanceRecord.find({
            session_id: input.sessionId,
        })
            .select("student_id source timestamp")
            .lean();

        const presentMap = new Map(
            records.map((r) => [r.student_id.toString(), r]),
        );

        const report = enrollments.map((e) => {
            const studentId = e.student_id?._id?.toString() ?? "";
            const record = presentMap.get(studentId);
            return {
                student: {
                    _id: e.student_id?._id,
                    name: e.student_id?.name,
                    email: e.student_id?.email,
                },
                status: record ? "present" : "absent",
                source: record?.source ?? null,
                timestamp: record?.timestamp ?? null,
            };
        });

        const presentCount = report.filter((r) => r.status === "present").length;

        return JSON.stringify({
            sessionId: input.sessionId,
            sessionDate: session.startTime,
            sessionStatus: session.status,
            totalStudents: enrollments.length,
            present: presentCount,
            absent: enrollments.length - presentCount,
            report,
        });
    },
};

// ===================================================================================
// EXPORT
// ===================================================================================

export default [getMyAttendance, getSessionReport];
