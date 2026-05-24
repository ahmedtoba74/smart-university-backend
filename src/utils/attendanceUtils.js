/**
 * ===================================================================================
 * @file      attendanceUtils.js
 * @desc      Utility functions for attendance percentage calculation and session cleanup.
 *            Exports three functions:
 *              - recalculateAttendance: per-student recalculation, called after each record.
 *              - recalculateAttendanceForOffering: bulk recalculation for all enrolled
 *                students, called at session end/expiry. Uses aggregation + bulkWrite
 *                to avoid exhausting the MongoDB connection pool on large courses.
 *              - expireDueSessions: cleanup job for naturally expired sessions; called
 *                by the setInterval in server.js every 5 minutes.
 * @module    src/utils/attendanceUtils
 * @requires  mongoose models, iotHubService
 * ===================================================================================
 */

import CourseOffering from '../../DB/models/courseOfferingModel.js';
import AttendanceSession from '../../DB/models/attendanceSessionModel.js';
import AttendanceRecord from '../../DB/models/attendanceRecordModel.js';
import Enrollment from '../../DB/models/enrollmentModel.js';
import * as iotHubService from '../services/iotHubService.js';

// ===================================================================================
// recalculateAttendance — Per-student, called after each record creation
// ===================================================================================

/**
 * Recalculate a single student's attendance percentage and grade for a course offering.
 * Called immediately after an AttendanceRecord is created (fingerprintMark, qrMark,
 * manualMarkAttendance). Updates the enrollment in a single atomic write.
 *
 * Performance: O(1) index hits via { student_id, courseOffering_id } compound index
 * on AttendanceRecord and { student_id, course_id } on Enrollment.
 *
 * Guards:
 *   - Returns early if offering not found.
 *   - Returns early if semesterWorkLocked (Phase 4 D-9) — grades are final.
 *   - Returns early if totalSessions === 0 — nothing to divide by.
 *
 * NAMING TRAP (MED-2): Enrollment uses `course_id` to reference CourseOffering.
 * All other Phase 5 models use `courseOffering_id`. Using the wrong field returns
 * null silently with no runtime error.
 *
 * @function recalculateAttendance
 * @param {import('mongoose').Types.ObjectId} studentId
 * @param {import('mongoose').Types.ObjectId} offeringId
 * @returns {Promise<void>}
 */
export const recalculateAttendance = async (studentId, offeringId) => {
    // 1. Fetch offering for gradingPolicy + lock status + college scope
    const offering = await CourseOffering.findById(offeringId).select(
        'gradingPolicy semesterWorkLocked college_id',
    );

    if (!offering) return;

    // Guard: do not write attendance grades after semester is locked (Phase 4 D-9)
    if (offering.semesterWorkLocked) return;

    // 2. Count total sessions for this offering (ALL statuses — no status filter).
    //    Every session that ever ran counts toward the denominator, even ended ones.
    //    The TTL index has been removed (CRIT-4) — sessions are permanent records.
    const totalSessions = await AttendanceSession.countDocuments({
        courseOffering_id: offeringId,
    });

    if (totalSessions === 0) return;

    // 3. Count sessions this student attended (index hit: student_id + courseOffering_id)
    const attendedSessions = await AttendanceRecord.countDocuments({
        student_id: studentId,
        courseOffering_id: offeringId,
    });

    // 4. Compute percentage and weighted grade.
    //    gradingPolicy.attendance = absolute degree allocation (e.g., 10 out of 100)
    //    attendanceGrade = (percentage / 100) * gradingPolicy.attendance
    //    Math.round(...* 100) / 100 = 2 decimal place precision
    const percentage = Math.round((attendedSessions / totalSessions) * 10000) / 100;
    const attendanceGrade =
        Math.round((percentage / 100) * offering.gradingPolicy.attendance * 100) / 100;

    // 5. Single atomic write — includes college_id for tenant isolation (CRIT-6)
    //    NAMING TRAP (MED-2): Enrollment uses `course_id`, NOT `courseOffering_id`
    await Enrollment.findOneAndUpdate(
        {
            student_id: studentId,
            course_id: offeringId,   // MED-2: intentional — Enrollment field is course_id
            status: 'enrolled',
            college_id: offering.college_id,
        },
        {
            finalAttendancePercentage: percentage,
            'grades.attendance': attendanceGrade,
        },
    );
};

// ===================================================================================
// recalculateAttendanceForOffering — Bulk, called at session end/expiry
// ===================================================================================

/**
 * Recalculate attendance for ALL enrolled students in a course offering.
 * Called when a session ends or expires. Required to correctly reduce percentages
 * for absent students — they have no AttendanceRecord but still count in the denominator.
 *
 * Performance: One countDocuments + one aggregation + one Enrollment.find + one bulkWrite.
 * NEVER use Promise.all(enrollments.map(recalculateAttendance)) — exhausts the MongoDB
 * connection pool on large courses with many enrolled students.
 *
 * Guards:
 *   - Returns early if offering not found or semesterWorkLocked (FIRST check — D-9).
 *   - Returns early if totalSessions === 0.
 *   - Returns early if no enrolled students.
 *
 * @function recalculateAttendanceForOffering
 * @param {import('mongoose').Types.ObjectId} offeringId
 * @returns {Promise<void>}
 */
export const recalculateAttendanceForOffering = async (offeringId) => {
    // Fetch offering — FIRST check must be semesterWorkLocked (D-9)
    const offering = await CourseOffering.findById(offeringId).select(
        'gradingPolicy semesterWorkLocked college_id',
    );

    // semesterWorkLocked guard is the FIRST check — if locked, grades are final
    if (!offering || offering.semesterWorkLocked) return;

    // Count total sessions (ALL statuses — no filter)
    const totalSessions = await AttendanceSession.countDocuments({
        courseOffering_id: offeringId,
    });

    if (totalSessions === 0) return;

    // Fetch all active enrollments for this offering
    // NAMING TRAP (MED-2): Enrollment uses `course_id`, NOT `courseOffering_id`
    const enrollments = await Enrollment.find({
        course_id: offeringId,         // MED-2: intentional
        status: 'enrolled',
        college_id: offering.college_id,
    }).select('student_id');

    if (enrollments.length === 0) return;

    // Aggregate attendance counts per student in a single DB round-trip
    const attendanceCounts = await AttendanceRecord.aggregate([
        {
            $match: {
                courseOffering_id: offering._id,
                student_id: { $in: enrollments.map((e) => e.student_id) },
            },
        },
        {
            $group: {
                _id: '$student_id',
                attended: { $sum: 1 },
            },
        },
    ]);

    // Build a Map for O(1) lookup: studentId.toString() → attendedCount
    const attendedByStudent = new Map(
        attendanceCounts.map((row) => [row._id.toString(), row.attended]),
    );

    // Build bulkWrite operations — students with no records get attended=0
    const bulkOps = enrollments.map((enrollment) => {
        const attended = attendedByStudent.get(enrollment.student_id.toString()) || 0;
        const percentage = Math.round((attended / totalSessions) * 10000) / 100;
        const attendanceGrade =
            Math.round(
                (percentage / 100) * offering.gradingPolicy.attendance * 100,
            ) / 100;

        return {
            updateOne: {
                filter: {
                    _id: enrollment._id,
                    status: 'enrolled',
                    college_id: offering.college_id,
                },
                update: {
                    $set: {
                        finalAttendancePercentage: percentage,
                        'grades.attendance': attendanceGrade,
                    },
                },
            },
        };
    });

    if (bulkOps.length > 0) await Enrollment.bulkWrite(bulkOps);
};

// ===================================================================================
// expireDueSessions — Natural session cleanup (GAP-14)
// ===================================================================================

/**
 * Find all sessions that have passed their expiresAt time but are still marked active,
 * transition them to 'expired', clear device templates (best-effort), and recalculate
 * attendance for all enrolled students.
 *
 * Called by setInterval in server.js every 5 minutes (see Step 17).
 *
 * Key design points:
 *   - Device template clearing is best-effort: clearDeviceTemplates failure must NOT
 *     prevent attendance recalculation. Errors are logged, not thrown.
 *   - recalculateAttendanceForOffering is called AFTER session.save() — the session
 *     must be expired before grades are recalculated to avoid double-counting.
 *   - Sessions are iterated sequentially (not in parallel) to avoid connection pool
 *     exhaustion when many sessions expire at once.
 *   - A simple semaphore prevents concurrent runs from overlapping (setInterval guard).
 *
 * @function expireDueSessions
 * @returns {Promise<void>}
 */
let _isExpiring = false;

export const expireDueSessions = async () => {
    if (_isExpiring) return;
    _isExpiring = true;

    try {
        const sessions = await AttendanceSession.find({
            status: 'active',
            expiresAt: { $lte: new Date() },
        });

        for (const session of sessions) {
            // Transition to expired state
            session.status = 'expired';
            session.endedAt = session.expiresAt; // Logical end time is when it was supposed to end
            session.endReason = 'expired';
            await session.save();

            // Best-effort device template clear — failure must NOT block recalculation
            if (session.deviceId) {
                await iotHubService
                    .clearDeviceTemplates(session.deviceId, session._id)
                    .catch((err) =>
                        console.error(
                            `[expireDueSessions] clearDeviceTemplates failed for ${session.deviceId}: ${err.message}`,
                        ),
                    );
            }

            // Recalculate for ALL enrolled students (including absent ones — D-12)
            await recalculateAttendanceForOffering(session.courseOffering_id);
        }
    } finally {
        _isExpiring = false;
    }
};
