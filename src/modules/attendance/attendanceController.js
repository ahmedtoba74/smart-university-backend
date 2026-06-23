/**
 * ===================================================================================
 * @file      attendanceController.js
 * @desc      Controller for the Phase 5 Fingerprint Attendance System.
 *            Handles session lifecycle, IoT fingerprint marking, QR fallback,
 *            manual overrides, fingerprint enrollment, and device heartbeats.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    src/modules/attendance/attendanceController
 */

import catchAsync from '../../utils/catchAsync.js';
import AppError from '../../utils/appError.js';
import { filterReqBody } from '../../utils/controllerUtils.js';
import APIFeatures from '../../utils/apiFeatures.js';
import { nanoid } from 'nanoid';
import mongoose from 'mongoose';
import AttendanceSession from '../../../DB/models/attendanceSessionModel.js';
import AttendanceRecord from '../../../DB/models/attendanceRecordModel.js';
import FingerprintTemplate from '../../../DB/models/fingerprintTemplateModel.js';
import FingerprintEnrollmentRequest from '../../../DB/models/fingerprintEnrollmentRequestModel.js';
import IoTDevice from '../../../DB/models/iotDeviceModel.js';
import Enrollment from '../../../DB/models/enrollmentModel.js';
import CourseOffering from '../../../DB/models/courseOfferingModel.js';
import Location from '../../../DB/models/locationModel.js';
import User from '../../../DB/models/userModel.js';
import { encryptFingerprintTemplate } from '../../utils/cryptoUtils.js';
import {
    recalculateAttendance,
    recalculateAttendanceForOffering,
} from '../../utils/attendanceUtils.js';
import * as iotHubService from '../../services/iotHubService.js';

// ─── Mass-Assignment Whitelists (BE-MED-3) ────────────────────────────────────
const CREATE_SESSION_ALLOWED  = ['courseOffering_id', 'location_id', 'forceHallSwitch', 'hallSwitchReason', 'durationMinutes'];
const END_SESSION_ALLOWED     = ['reason'];
const MANUAL_MARK_ALLOWED     = ['student_id', 'overrideReason'];
const OVERRIDE_RECORD_ALLOWED = ['overrideReason'];
const ENROLL_MODE_ALLOWED     = ['studentId', 'deviceId'];

// ===================================================================================
// SESSION MANAGEMENT
// ===================================================================================

/**
 * Create an attendance session.
 * Resolves location from schedule, pushes fingerprint templates to device,
 * and auto-enables QR fallback if device is unavailable.
 * @route POST /attendance/sessions
 * @access doctor, ta
 */
export const createSession = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, CREATE_SESSION_ALLOWED);
    const { courseOffering_id, location_id, forceHallSwitch, hallSwitchReason, durationMinutes } = body;

    // ── 1. Authorization ──────────────────────────────────────────────────────
    const offering = await CourseOffering.findById(courseOffering_id);
    if (!offering) return next(new AppError('Course offering not found.', 404));
    if (offering.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }
    const isDoctor = offering.doctors_ids.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering.tas_ids.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA) {
        return next(new AppError('You are not assigned to this course offering.', 403));
    }
    if (offering.semesterWorkLocked || offering.resultsPublished) {
        return next(
            new AppError(
                'Attendance cannot be opened after semester work is locked or results are published.',
                400,
            ),
        );
    }

    // ── 2. Duplicate Active Session Guard (GAP-9) ─────────────────────────────
    const existingForOffering = await AttendanceSession.findOne({
        courseOffering_id,
        status: 'active',
        expiresAt: { $gt: new Date() },
    });
    if (existingForOffering) {
        return res.status(200).json({
            status: 'success',
            data: { session: existingForOffering, alreadyActive: true },
        });
    }

    // ── 3. Resolve Location ────────────────────────────────────────────────────
    let resolvedLocationId = location_id;
    let hallSwitch = false;
    let originalLocationId = null;

    // Helper to resolve the scheduled location for the current time slot (GAP-10)
    const resolveScheduledLocation = () => {
        const timezone = process.env.UNIVERSITY_TIMEZONE || 'Africa/Cairo';
        const localNow = new Date();
        const dayName = new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            timeZone: timezone,
        }).format(localNow);
        const localTimeStr = localNow.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone,
        });
        const [nowH, nowM] = localTimeStr.split(':').map(Number);
        const nowMinutes = nowH * 60 + nowM;
        const openBefore = Number(process.env.ATTENDANCE_OPEN_BEFORE_MINUTES || 15);
        const closeAfter = Number(process.env.ATTENDANCE_CLOSE_AFTER_MINUTES || 15);

        const slot = offering.schedule?.find((s) => {
            if (s.day !== dayName) return false;
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            const slotStart = sh * 60 + sm - openBefore;
            const slotEnd = eh * 60 + em + closeAfter;
            return nowMinutes >= slotStart && nowMinutes <= slotEnd;
        });
        return slot?.location || null;
    };

    if (location_id) {
        // Hall switch path — check for conflict at target hall
        const conflict = await AttendanceSession.findOne({
            location_id,
            college_id: offering.college_id,
            status: 'active',
            expiresAt: { $gt: new Date() },
        }).populate('courseOffering_id initiatedBy_id');

        if (conflict && !forceHallSwitch) {
            return res.status(409).json({
                status: 'fail',
                message: 'Hall has an active session.',
                conflictingSession: {
                    courseTitle: conflict.courseOffering_id?.title || null,
                    doctorName: conflict.initiatedBy_id?.name || null,
                    startTime: conflict.startTime,
                    expiresAt: conflict.expiresAt,
                },
            });
        }
        if (conflict && forceHallSwitch && !hallSwitchReason) {
            return next(new AppError('Reason required for hall switch.', 400));
        }
        if (forceHallSwitch) {
            hallSwitch = true;
            originalLocationId = resolveScheduledLocation();
        }
    } else {
        const scheduledLoc = resolveScheduledLocation();
        if (!scheduledLoc) {
            return next(new AppError('No scheduled session found for the current time window.', 400));
        }
        resolvedLocationId = scheduledLoc;
    }

    // ── 4. Resolve Device ─────────────────────────────────────────────────────
    const location = await Location.findById(resolvedLocationId);
    if (!location) return next(new AppError('Location not found.', 404));

    let deviceId = location.readerId || null;
    let qrFallbackEnabled = false;

    if (!deviceId || location.status === 'maintenance') {
        qrFallbackEnabled = true;
        deviceId = null;
    } else {
        // Optionally verify device is registered and active
        const device = await IoTDevice.findOne({
            deviceId,
            role: 'room',
            isActive: true,
            college_id: offering.college_id,
        });
        if (!device) {
            console.warn(
                `[createSession] IoT device '${deviceId}' not found in registry ` +
                `(college ${offering.college_id}). Falling back to QR mode.`,
            );
            qrFallbackEnabled = true;
        }
    }

    // ── 5. Query Enrolled Students ─────────────────────────────────────────────
    // NAMING TRAP (MED-2): Enrollment uses `course_id`, NOT `courseOffering_id`
    const enrollments = await Enrollment.find({
        course_id: courseOffering_id,
        status: 'enrolled',
    }).select('student_id');
    const studentIds = enrollments.map((e) => e.student_id);

    // ── 6. Query Fingerprint Templates ────────────────────────────────────────
    const templates = await FingerprintTemplate.find({
        student_id: { $in: studentIds },
        isActive: true,
    }).select('+templateData +templateIv +templateAuthTag');

    if (templates.length > 200) {
        return next(
            new AppError(
                `Template count (${templates.length}) exceeds the R503 device capacity limit of 200. Reduce enrolled students or use QR fallback.`,
                400,
            ),
        );
    }

    // ── 7. Build Template Mapping (D-2) ───────────────────────────────────────
    // sessionId pre-generated so it can be included in the IoT payload BEFORE DB create
    const sessionId = new mongoose.Types.ObjectId();
    const sessionNonce = nanoid(32);
    const templateBatchId = nanoid(16);
    const templateMapping = templates.map((t, idx) => ({
        localId: idx,
        student_id: t.student_id,
    }));

    // ── 8. Push Templates to Device ───────────────────────────────────────────
    let templateLoadStatus = 'pending';
    let templatesLoadedCount = 0;
    let finalTemplateMapping = templateMapping;

    if (!qrFallbackEnabled && deviceId) {
        const iotResult = await iotHubService.pushTemplatesToDevice(
            deviceId,
            templates,
            { sessionId, sessionNonce, templateBatchId },
        );
        const loaded = iotResult.templatesLoaded ?? 0;
        const requested = iotResult.totalRequested ?? templates.length;

        if (iotResult.success && loaded === requested) {
            templateLoadStatus = 'loaded';
            templatesLoadedCount = loaded;
        } else if (loaded > 0 && loaded < requested) {
            // D-2A: partial load — trim mapping to loaded indices only, enable QR
            templateLoadStatus = 'failed';
            templatesLoadedCount = loaded;
            finalTemplateMapping = templateMapping.slice(0, loaded);
            qrFallbackEnabled = true;
            console.warn(
                `[createSession] Partial template load on ${deviceId}: ${loaded}/${requested}. ` +
                    `QR fallback enabled.`,
            );
        } else {
            templateLoadStatus = 'failed';
            templatesLoadedCount = 0;
            qrFallbackEnabled = true;
            if (iotResult.error) {
                console.warn(`[createSession] Template push failed: ${iotResult.error}`);
            }
        }
    } else if (qrFallbackEnabled) {
        templateLoadStatus = 'qr_fallback';
    }

    // ── 9. Create Session ─────────────────────────────────────────────────────
    const duration = Number(durationMinutes || process.env.ATTENDANCE_SESSION_DURATION_MINUTES || 90);
    const initialQrToken = qrFallbackEnabled ? nanoid(32) : null;
    const initialQrExpiry = qrFallbackEnabled
        ? new Date(Date.now() + Number(process.env.QR_TOKEN_TTL_SECONDS || 30) * 1000)
        : null;

    // college_id from offering.college_id — NOT from req.scopeFilter (verified ownership)
    const session = await AttendanceSession.create({
        _id: sessionId,
        courseOffering_id,
        location_id: resolvedLocationId,
        initiatedBy_id: req.user._id,
        college_id: offering.college_id,
        deviceId: deviceId || null,
        sessionNonce,
        templateBatchId,
        status: 'active',
        templateLoadStatus,
        templatesLoadedCount,
        templateMapping: finalTemplateMapping,
        qrFallbackEnabled,
        qrFallbackToken: initialQrToken,
        qrTokenExpiresAt: initialQrExpiry,
        originalLocation_id: hallSwitch ? originalLocationId : null,
        hallSwitchReason: hallSwitch ? hallSwitchReason : null,
        expiresAt: new Date(Date.now() + duration * 60 * 1000),
    });

    res.status(201).json({
        status: 'success',
        data: {
            session,
            studentsWithoutFingerprint: studentIds.length - templates.length,
            templateLoadStatus,
            qrFallbackEnabled,
            ...(qrFallbackEnabled && { qrFallbackToken: initialQrToken }),
        },
    });
});

/**
 * List attendance sessions for a course offering.
 * @route GET /attendance/sessions
 * @access doctor, ta, collegeAdmin
 */
export const getSessions = catchAsync(async (req, res, next) => {
    const { courseOffering_id } = req.query;
    if (!courseOffering_id) return next(new AppError('courseOffering_id query parameter is required.', 400));

    const offering = await CourseOffering.findById(courseOffering_id);
    if (!offering) return next(new AppError('Course offering not found.', 404));
    if (offering.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    const filter = {
        courseOffering_id,
        college_id: req.scopeFilter.college_id,
    };
    if (req.query.active === 'true') {
        filter.status = 'active';
        filter.expiresAt = { $gt: new Date() };
    }

    const features = new APIFeatures(AttendanceSession.find(filter), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const sessions = await features.query
        .populate('location_id', 'name building roomNumber')
        .populate('initiatedBy_id', 'name email');

    const totalResults = await features.countTotal(AttendanceSession, filter);

    res.status(200).json({
        status: 'success',
        results: sessions.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / (features.limit || 10)),
        totalResults,
        data: { sessions },
    });
});

/**
 * Force-end an active attendance session, clear device templates, and recalculate attendance.
 * @route PATCH /attendance/sessions/:id/end
 * @access doctor, ta, collegeAdmin
 */
export const endSession = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, END_SESSION_ALLOWED);

    // ── 1. Fetch + IDOR Guard ─────────────────────────────────────────────────
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    // ── 2. Already Expired Guard ──────────────────────────────────────────────
    if (session.status !== 'active' || session.expiresAt < new Date()) {
        return next(new AppError('Session has already expired.', 400));
    }

    // ── 3. Staff Authorization ────────────────────────────────────────────────
    const offering = await CourseOffering.findById(session.courseOffering_id);
    const isDoctor = offering?.doctors_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering?.tas_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA && req.user.role !== 'collegeAdmin') {
        return next(new AppError('You are not authorized to end this session.', 403));
    }

    // ── 4. Clear Device Templates (best-effort) ───────────────────────────────
    if (session.deviceId) {
        await iotHubService
            .clearDeviceTemplates(session.deviceId, session._id)
            .catch((err) =>
                console.error(`[endSession] clearDeviceTemplates failed: ${err.message}`),
            );
    }

    // ── 5. Compute Attendance Count ───────────────────────────────────────────
    const attendanceCount = await AttendanceRecord.countDocuments({
        session_id: session._id,
    });

    // ── 6. End Session ────────────────────────────────────────────────────────
    session.status = 'ended';
    session.endedAt = new Date();
    session.expiresAt = session.endedAt;
    session.endedBy = req.user._id;
    session.endReason = body.reason || 'manual_end';
    await session.save();

    // ── 7. Recalculate All Enrolled Students (D-12) ───────────────────────────
    await recalculateAttendanceForOffering(session.courseOffering_id);

    res.status(200).json({
        status: 'success',
        data: { message: 'Session ended.', attendanceCount },
    });
});

/**
 * Enable QR fallback for an active session and generate the initial QR token.
 * @route PATCH /attendance/sessions/:id/enable-qr
 * @access doctor, ta
 */
export const enableQrFallback = catchAsync(async (req, res, next) => {
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }
    if (session.qrFallbackEnabled) {
        return next(new AppError('QR fallback is already enabled.', 400));
    }
    if (session.status !== 'active' || session.expiresAt < new Date()) {
        return next(new AppError('Session has already expired.', 400));
    }

    const offering = await CourseOffering.findById(session.courseOffering_id);
    const isDoctor = offering?.doctors_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering?.tas_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA) {
        return next(new AppError('You are not authorized to enable QR fallback.', 403));
    }

    session.qrFallbackEnabled = true;
    session.qrFallbackToken = nanoid(32);
    session.qrTokenExpiresAt = new Date(
        Date.now() + Number(process.env.QR_TOKEN_TTL_SECONDS || 30) * 1000,
    );
    session.templateLoadStatus = 'qr_fallback';
    await session.save();

    res.status(200).json({
        status: 'success',
        data: {
            session,
            qrToken: session.qrFallbackToken,
            expiresIn: Number(process.env.QR_TOKEN_TTL_SECONDS || 30),
        },
    });
});

/**
 * Refresh the rotating QR token for an active session with QR fallback enabled.
 * Keeps the old token alive for the grace window (QR_TOKEN_GRACE_SECONDS).
 * @route GET /attendance/sessions/:id/qr-token
 * @access doctor, ta
 */
export const refreshQrToken = catchAsync(async (req, res, next) => {
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }
    if (!session.qrFallbackEnabled) {
        return next(new AppError('QR fallback is not enabled.', 400));
    }
    if (session.status !== 'active' || session.expiresAt < new Date()) {
        return next(new AppError('Session has already expired.', 400));
    }

    const offering = await CourseOffering.findById(session.courseOffering_id);
    const isDoctor = offering?.doctors_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering?.tas_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA) {
        return next(new AppError('You are not authorized to refresh the QR token.', 403));
    }

    // Rotate: keep previous token for grace window
    session.previousQrFallbackToken = session.qrFallbackToken;
    session.previousQrTokenExpiresAt = session.qrTokenExpiresAt;
    session.qrFallbackToken = nanoid(32);
    session.qrTokenExpiresAt = new Date(
        Date.now() + Number(process.env.QR_TOKEN_TTL_SECONDS || 30) * 1000,
    );
    await session.save();

    res.status(200).json({
        status: 'success',
        data: {
            qrToken: session.qrFallbackToken,
            expiresIn: Number(process.env.QR_TOKEN_TTL_SECONDS || 30),
            graceSeconds: Number(process.env.QR_TOKEN_GRACE_SECONDS || 10),
        },
    });
});

// ===================================================================================
// ATTENDANCE MARKING
// ===================================================================================

/**
 * IoT device reports a fingerprint match. Resolves student from templateMapping,
 * validates enrollment, creates AttendanceRecord, and recalculates percentage.
 * Supports offline-cached scans arriving after session expiry (GAP-8).
 * @route POST /attendance/fingerprint-mark
 * @access IoT device (x-device-secret)
 */
export const fingerprintMark = catchAsync(async (req, res, next) => {
    const {
        deviceId,
        sessionId,
        sessionNonce,
        templateBatchId,
        fingerprintLocalId,
        confidence,
        timestamp,
    } = req.body;

    // ── 1. Validate Required Fields ───────────────────────────────────────────
    if (!deviceId || !sessionId || !sessionNonce || !templateBatchId || fingerprintLocalId === undefined) {
        return next(new AppError('Missing required fields in device payload.', 400));
    }

    // ── 2. Resolve Location ────────────────────────────────────────────────────
    // Location has isArchived pre-find hook — archived locations return null → 404
    const location = await Location.findOne({ readerId: deviceId });
    if (!location) return next(new AppError('Unknown device.', 404));

    // ── 3. Find Session (by cryptographic identity — no status filter) ─────────
    // BE-CRIT: Do NOT add status: 'active' — offline scans arrive after expiry
    const session = await AttendanceSession.findOne({
        _id: sessionId,
        sessionNonce,
        templateBatchId,
        location_id: location._id,
    });
    if (!session) return next(new AppError('No session found for this device event.', 400));

    // ── Validate Scan Timestamp ────────────────────────────────────────────────
    let scanTime;
    try {
        scanTime = timestamp ? new Date(timestamp) : new Date();
        if (isNaN(scanTime.getTime())) return next(new AppError('Invalid scan timestamp.', 400));
    } catch {
        return next(new AppError('Invalid scan timestamp.', 400));
    }

    const clockSkewMs = Number(process.env.DEVICE_CLOCK_SKEW_SECONDS || 120) * 1000;
    if (scanTime > new Date(Date.now() + clockSkewMs)) {
        return next(new AppError('Scan timestamp is too far in the future.', 400));
    }

    const sessionStart = session.startTime || session.createdAt;
    const sessionEnd = session.endedAt || session.expiresAt;
    if (scanTime < sessionStart || scanTime > sessionEnd) {
        return next(new AppError('Scan timestamp is outside the attendance session window.', 400));
    }

    // ── 4. Resolve Student from Template Mapping (D-2) ────────────────────────
    const mapping = session.templateMapping.find((m) => m.localId === fingerprintLocalId);
    if (!mapping) return next(new AppError('Unknown fingerprint local ID.', 400));
    const student_id = mapping.student_id;

    // ── 5. Enrollment Guard ────────────────────────────────────────────────────
    // NAMING TRAP (MED-2): Enrollment uses `course_id`
    const enrollment = await Enrollment.findOne({
        student_id,
        course_id: session.courseOffering_id,
        status: 'enrolled',
        college_id: session.college_id,
    });
    if (!enrollment) return next(new AppError('Student not enrolled.', 400));

    // ── Confidence Check ──────────────────────────────────────────────────────
    const minConfidence = Number(process.env.FINGERPRINT_MIN_CONFIDENCE || 40);
    if (confidence < minConfidence) {
        return next(new AppError('Fingerprint confidence below threshold.', 400));
    }

    // ── 6. Duplicate Check + Create Record (BE-CRIT-2, BE-CRIT-3) ─────────────
    let record;
    try {
        record = await AttendanceRecord.create({
            session_id: session._id,
            student_id,
            source: 'fingerprint',
            deviceId,
            confidence,
            scannedAt: scanTime,
            receivedAt: new Date(),
            sessionNonce,
            templateBatchId,
            college_id: session.college_id,
            courseOffering_id: session.courseOffering_id,
            timestamp: scanTime,
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(200).json({
                status: 'success',
                data: { alreadyMarked: true },
            });
        }
        throw err; // Re-throw other errors for catchAsync → globalErrorHandler
    }

    // ── 7. Recalculate Attendance (OUTSIDE try/catch — BE-CRIT-3) ─────────────
    await recalculateAttendance(student_id, session.courseOffering_id);

    // ── 8. Response (includes ledCommand for Azure Function relay) ────────────
    res.status(200).json({
        status: 'success',
        data: { record, ledCommand: 'green' },
    });
});

/**
 * Student submits attendance via QR code scan.
 * Validates active session, QR fallback enabled, token (current + grace window), enrollment.
 * @route POST /attendance/qr-mark
 * @access student
 */
export const qrMark = catchAsync(async (req, res, next) => {
    const { sessionId, qrToken } = req.body;

    // ── 1. Fetch Session + IDOR Guard ─────────────────────────────────────────
    const session = await AttendanceSession.findById(sessionId);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    // ── 2. Session Guards ─────────────────────────────────────────────────────
    if (session.status !== 'active' || session.expiresAt < new Date()) {
        return next(new AppError('Session has expired.', 400));
    }
    if (!session.qrFallbackEnabled) {
        return next(new AppError('QR fallback is not enabled for this session.', 400));
    }

    // ── 3. QR Token Validation (current + previous grace window) — MED-8 ──────
    const graceMs = Number(process.env.QR_TOKEN_GRACE_SECONDS || 10) * 1000;
    const now = new Date();
    const currentTokenValid =
        session.qrFallbackToken === qrToken &&
        session.qrTokenExpiresAt &&
        now <= session.qrTokenExpiresAt;
    const previousTokenValid =
        session.previousQrFallbackToken === qrToken &&
        session.previousQrTokenExpiresAt &&
        now <= new Date(session.previousQrTokenExpiresAt.getTime() + graceMs);
    if (!currentTokenValid && !previousTokenValid) {
        return next(new AppError('Invalid or expired QR token.', 400));
    }

    // ── 4. Enrollment Guard (BE-MED-5 — defense-in-depth, uses req.scopeFilter) ─
    // NAMING TRAP (MED-2): Enrollment uses `course_id`
    const enrollment = await Enrollment.findOne({
        student_id: req.user._id,
        course_id: session.courseOffering_id,
        status: 'enrolled',
        college_id: req.scopeFilter.college_id, // BE-MED-5: req.scopeFilter, NOT session.college_id
    });
    if (!enrollment) return next(new AppError('You are not enrolled in this course.', 403));

    // ── 5. Duplicate Check + Create Record ────────────────────────────────────
    let record;
    try {
        record = await AttendanceRecord.create({
            session_id: session._id,
            student_id: req.user._id,
            source: 'qr',
            college_id: session.college_id,
            courseOffering_id: session.courseOffering_id,
            timestamp: new Date(),
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(200).json({
                status: 'success',
                data: { alreadyMarked: true },
            });
        }
        throw err;
    }

    // ── 6. Recalculate Attendance (OUTSIDE try/catch) ─────────────────────────
    await recalculateAttendance(req.user._id, session.courseOffering_id);

    res.status(200).json({
        status: 'success',
        data: { success: true },
    });
});

/**
 * Get a full attendance report for a session (present/absent breakdown).
 * @route GET /attendance/sessions/:sessionId/report
 * @access doctor, ta, collegeAdmin
 */
export const getSessionReport = catchAsync(async (req, res, next) => {
    const session = await AttendanceSession.findById(req.params.sessionId);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    const offering = await CourseOffering.findById(session.courseOffering_id);
    if (req.user.role !== 'collegeAdmin') {
        const isDoctor = offering?.doctors_ids?.some(
            (id) => id.toString() === req.user._id.toString(),
        );
        const isTA = offering?.tas_ids?.some(
            (id) => id.toString() === req.user._id.toString(),
        );
        if (!isDoctor && !isTA) {
            return next(new AppError('You are not authorized to view this report.', 403));
        }
    }

    const records = await AttendanceRecord.find({ session_id: session._id })
        .populate('student_id', 'name email')
        .sort({ timestamp: 1 });

    // NAMING TRAP (MED-2): Enrollment uses `course_id`
    const enrollments = await Enrollment.find({
        course_id: session.courseOffering_id,
        status: 'enrolled',
    }).populate('student_id', 'name email');

    const presentIds = records.map((r) => r.student_id._id.toString());
    const absentStudents = enrollments
        .filter((e) => !presentIds.includes(e.student_id._id.toString()))
        .map((e) => e.student_id);

    res.status(200).json({
        status: 'success',
        data: {
            session,
            present: records,
            absent: absentStudents,
            summary: {
                total: enrollments.length,
                present: records.length,
                absent: absentStudents.length,
                attendanceRate:
                    enrollments.length === 0
                        ? 0
                        : Number(((records.length / enrollments.length) * 100).toFixed(1)),
            },
        },
    });
});

/**
 * Student retrieves their own attendance history and summary for a course offering.
 * @route GET /attendance/my
 * @access student
 */
export const getMyAttendance = catchAsync(async (req, res, next) => {
    const { courseOffering_id } = req.query;
    if (!courseOffering_id) {
        return next(new AppError('courseOffering_id query parameter is required.', 400));
    }

    // Enrollment guard — also confirms student belongs to this course + college
    // NAMING TRAP (MED-2): Enrollment uses `course_id`
    const enrollment = await Enrollment.findOne({
        student_id: req.user._id,
        course_id: courseOffering_id,
        college_id: req.scopeFilter.college_id,
    });
    if (!enrollment) return next(new AppError('You are not enrolled in this course.', 403));

    const records = await AttendanceRecord.find({
        student_id: req.user._id,
        courseOffering_id,
        college_id: req.scopeFilter.college_id,
    }).sort({ timestamp: -1 }); // Sort by timestamp field (not createdAt)

    // Count ALL sessions — no status filter (active + expired + ended all count)
    const totalSessions = await AttendanceSession.countDocuments({ courseOffering_id });

    res.status(200).json({
        status: 'success',
        data: {
            records,
            summary: {
                attended: records.length,
                total: totalSessions,
                percentage: enrollment.finalAttendancePercentage,
                attendanceGrade: enrollment.grades?.attendance,
            },
        },
    });
});

/**
 * Doctor/TA manually overrides an attendance record (change source to manual_override).
 * overrideBy is set server-side from req.user._id — never from body.
 * @route PATCH /attendance/records/:id
 * @access doctor, ta, collegeAdmin
 */
export const overrideAttendance = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, OVERRIDE_RECORD_ALLOWED);
    const { overrideReason } = body;

    // ── 1. Fetch + IDOR Guard ─────────────────────────────────────────────────
    const record = await AttendanceRecord.findById(req.params.id);
    if (!record) return next(new AppError('Attendance record not found.', 404));
    if (record.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    // ── 2. Staff Authorization ────────────────────────────────────────────────
    const session = await AttendanceSession.findById(record.session_id);
    const offering = session
        ? await CourseOffering.findById(session.courseOffering_id)
        : null;
    const isDoctor = offering?.doctors_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering?.tas_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA && req.user.role !== 'collegeAdmin') {
        return next(new AppError('You are not authorized to override this record.', 403));
    }

    // ── 3. Update Server-Side Only ─────────────────────────────────────────────
    record.source = 'manual_override';
    record.overrideBy = req.user._id; // Server-side — NEVER from body
    record.overrideReason = overrideReason;
    await record.save();

    // ── 4. Recalculate Attendance (defense-in-depth — override may affect grades) ──
    await recalculateAttendance(record.student_id, record.courseOffering_id);

    res.status(200).json({
        status: 'success',
        data: { record },
    });
});

/**
 * Doctor/TA manually marks a student present in an active session.
 * Creates a new AttendanceRecord. Use this when fingerprint and QR both failed.
 * @route POST /attendance/sessions/:sessionId/manual-mark
 * @access doctor, ta, collegeAdmin
 */
export const manualMarkAttendance = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, MANUAL_MARK_ALLOWED);
    const { student_id, overrideReason } = body;

    // ── 1. Fetch Session + IDOR Guard ─────────────────────────────────────────
    const session = await AttendanceSession.findById(req.params.sessionId);
    if (!session) return next(new AppError('Session not found.', 404));
    if (session.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }
    if (session.status !== 'active' || session.expiresAt < new Date()) {
        return next(new AppError('Session has already expired.', 400));
    }

    // ── 2. Staff Authorization ─────────────────────────────────────────────────
    const offering = await CourseOffering.findById(session.courseOffering_id);
    const isDoctor = offering?.doctors_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    const isTA = offering?.tas_ids?.some(
        (id) => id.toString() === req.user._id.toString(),
    );
    if (!isDoctor && !isTA && req.user.role !== 'collegeAdmin') {
        return next(new AppError('You are not authorized to mark attendance manually.', 403));
    }

    // ── 3. Enrollment Guard ────────────────────────────────────────────────────
    // NAMING TRAP (MED-2): Enrollment uses `course_id`
    const enrollment = await Enrollment.findOne({
        student_id,
        course_id: session.courseOffering_id,
        status: 'enrolled',
        college_id: req.scopeFilter.college_id,
    });
    if (!enrollment) return next(new AppError('Student is not enrolled in this course.', 400));

    // ── 4. Duplicate Check + Create Record ─────────────────────────────────────
    let record;
    try {
        record = await AttendanceRecord.create({
            session_id: session._id,
            student_id,
            courseOffering_id: session.courseOffering_id,
            college_id: req.scopeFilter.college_id,
            source: 'manual_override',
            overrideReason,
            overrideBy: req.user._id,
            timestamp: new Date(),
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(200).json({
                status: 'success',
                data: { alreadyMarked: true },
            });
        }
        throw err;
    }

    // ── 5. Recalculate Attendance (OUTSIDE try/catch) ──────────────────────────
    await recalculateAttendance(student_id, session.courseOffering_id);

    res.status(201).json({
        status: 'success',
        data: { record },
    });
});

/**
 * IoT device sends a periodic health ping. Upserts IoTDevice record.
 * @route POST /attendance/devices/heartbeat
 * @access IoT device (x-device-secret)
 */
export const deviceHeartbeat = catchAsync(async (req, res, next) => {
    const { deviceId, firmwareVersion, freeHeap, wifiRSSI, uptime, timestamp } = req.body;

    if (!deviceId) {
        return next(new AppError('deviceId is required.', 400));
    }

    const device = await IoTDevice.findOneAndUpdate(
        { deviceId },
        {
            firmwareVersion,
            lastHeartbeatAt: timestamp ? new Date(timestamp) : new Date(),
            lastSeenAt: new Date(),
            isOnline: true,
            diagnostics: { freeHeap, wifiRSSI, uptime },
        },
        { new: true },
    );

    if (!device) {
        return res.status(404).json({
            status: 'fail',
            message: `Device '${deviceId}' is not registered. Contact admin.`,
        });
    }

    res.status(200).json({
        status: 'success',
        data: { received: true },
    });
});

// ===================================================================================
// FINGERPRINT ENROLLMENT
// ===================================================================================

/**
 * Trigger enrollment mode on the central fingerprint device.
 * Creates a FingerprintEnrollmentRequest with a 2-minute nonce TTL.
 * @route POST /attendance/fingerprints/enroll-mode
 * @access collegeAdmin
 */
export const triggerEnrollMode = catchAsync(async (req, res, next) => {
    const body = filterReqBody(req.body, ENROLL_MODE_ALLOWED);
    const { studentId } = body;
    let { deviceId } = body;

    // ── 1. Validate Student ────────────────────────────────────────────────────
    const student = await User.findById(studentId);
    if (!student) return next(new AppError('Student not found.', 400));
    if (student.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('Student does not belong to your college.', 403));
    }

    // Prevent enrollment of already enrolled fingerprint (Refinement 1)
    const existingTemplate = await FingerprintTemplate.findOne({
        student_id: studentId,
        isActive: true,
    });
    if (existingTemplate) {
        return next(new AppError('Student already has an active fingerprint template.', 400));
    }

    // ── 2. Resolve Device ─────────────────────────────────────────────────────
    if (!deviceId) {
        const centralDevice = await IoTDevice.findOne({
            role: 'central',
            college_id: req.scopeFilter.college_id,
            isActive: true,
        });
        deviceId = centralDevice?.deviceId || process.env.IOT_CENTRAL_DEVICE_ID || null;
    }
    if (!deviceId) {
        return next(new AppError('No enrollment device found. Set IOT_CENTRAL_DEVICE_ID or register a central device.', 400));
    }

    // ── 3. Create Enrollment Request ──────────────────────────────────────────
    const enrollmentNonce = nanoid(32); // Server-side — never from body
    await FingerprintEnrollmentRequest.create({
        student_id: studentId,
        requestedBy: req.user._id,
        college_id: req.scopeFilter.college_id,
        deviceId,
        nonce: enrollmentNonce,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2-minute TTL
    });

    // ── 4. Trigger IoT Hub ────────────────────────────────────────────────────
    await iotHubService.triggerEnrollmentMode(deviceId, {
        studentId,
        enrolledBy: req.user._id,
        enrollmentNonce,
    });

    res.status(200).json({
        status: 'success',
        data: { message: 'Enrollment mode activated.', deviceId, expiresIn: 120 },
    });
});

/**
 * Save a fingerprint template received from the ESP32 after enrollment capture.
 * Validates the pending enrollment request nonce before persisting.
 * @route POST /attendance/fingerprints/register
 * @access IoT device (x-device-secret)
 */
export const registerFingerprint = catchAsync(async (req, res, next) => {
    const { studentId, enrollmentNonce, deviceId, templateData, quality, success } = req.body;

    if (success === false) {
        return next(
            new AppError(
                req.body.error
                    ? `Enrollment failed on device: ${req.body.error}`
                    : 'Enrollment failed on device.',
                400,
            ),
        );
    }

    if (!enrollmentNonce) {
        return next(new AppError('enrollmentNonce is required.', 400));
    }

    // ── 1. Validate Enrollment Request ────────────────────────────────────────
    const request = await FingerprintEnrollmentRequest.findOne({
        student_id: studentId,
        nonce: enrollmentNonce,
        deviceId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
    });
    if (!request) {
        return next(new AppError('Invalid or expired enrollment request.', 400));
    }

    // ── Validate Student and College Match (Refinement 2) ─────────────────────
    const student = await User.findById(studentId);
    if (!student) {
        return next(new AppError('Student not found.', 400));
    }
    if (!student.college_id || student.college_id.toString() !== request.college_id.toString()) {
        return next(new AppError('Student/College association mismatch or invalid college.', 400));
    }

    // ── Validate Quality (Refinement 3) ──────────────────────────────────────
    const minConfidence = Number(process.env.FINGERPRINT_MIN_CONFIDENCE || 40);
    if (quality !== undefined && quality < minConfidence) {
        return next(new AppError(`Fingerprint quality (${quality}) is below minimum threshold (${minConfidence}).`, 400));
    }

    // ── 2. Validate Template Size ─────────────────────────────────────────────
    let decoded;
    try {
        decoded = Buffer.from(templateData, 'base64');
    } catch {
        return next(new AppError('Invalid template data encoding.', 400));
    }
    if (decoded.length !== 768) {
        return next(new AppError('Invalid fingerprint template size. Expected 768 bytes.', 400));
    }

    // ── 3. Encrypt Template (D-13) ────────────────────────────────────────────
    const { ciphertext, iv, authTag } = encryptFingerprintTemplate(decoded);

    // ── 4. Upsert Template (one per student) ──────────────────────────────────
    const template = await FingerprintTemplate.findOneAndUpdate(
        { student_id: studentId },
        {
            student_id: studentId,
            templateData: ciphertext,
            templateIv: iv,
            templateAuthTag: authTag,
            encryptionVersion: 1,
            quality: quality || null,
            enrolledViaDevice: deviceId,
            enrolledBy: request.requestedBy,
            college_id: request.college_id,
            isActive: true,
        },
        { upsert: true, new: true },
    );

    // ── 5. Mark Request Completed ─────────────────────────────────────────────
    request.status = 'completed';
    await request.save();

    res.status(201).json({
        status: 'success',
        data: { enrolled: true, templateId: template._id },
    });
});

/**
 * List all fingerprint templates for a college (metadata only — no biometric data).
 * @route GET /attendance/fingerprints
 * @access collegeAdmin
 */
export const listFingerprints = catchAsync(async (req, res) => {
    const filter = { college_id: req.scopeFilter.college_id };
    const features = new APIFeatures(FingerprintTemplate.find(filter), req.query)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const templates = await features.query
        .populate('student_id', 'name email')
        .populate('enrolledBy', 'name email');

    const totalResults = await features.countTotal(FingerprintTemplate, filter);

    res.status(200).json({
        status: 'success',
        results: templates.length,
        totalResults,
        data: { templates },
    });
});

/**
 * Check whether a specific student has an enrolled fingerprint template.
 * Never returns biometric data fields.
 * @route GET /attendance/fingerprints/student/:studentId
 * @access collegeAdmin
 */
export const checkStudentFingerprint = catchAsync(async (req, res) => {
    // select: false on templateData/templateIv/templateAuthTag means they are excluded
    // unless explicitly requested with .select('+field'). Never request them here.
    const template = await FingerprintTemplate.findOne({
        student_id: req.params.studentId,
        college_id: req.scopeFilter.college_id,
    })
        .populate('student_id', 'name email');

    res.status(200).json({
        status: 'success',
        data: { enrolled: !!template, template: template || null },
    });
});

/**
 * Hard-delete a fingerprint template.
 * Not a soft-delete — device templates are session-scoped and cleared at session end.
 * @route DELETE /attendance/fingerprints/:id
 * @access collegeAdmin
 */
export const deleteFingerprint = catchAsync(async (req, res, next) => {
    const template = await FingerprintTemplate.findById(req.params.id);
    if (!template) return next(new AppError('Fingerprint template not found.', 404));
    if (template.college_id.toString() !== req.scopeFilter.college_id.toString()) {
        return next(new AppError('You do not have access to this resource.', 403));
    }

    await template.deleteOne();

    res.status(204).json({
        status: 'success',
        data: null,
    });
});
