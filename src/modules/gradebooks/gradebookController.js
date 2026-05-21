/**
 * ===================================================================================
 * @file      gradebookController.js
 * @desc      Controller for gradebook management and GPA calculation.
 *            Handles semester work entry, locking, final exam entry, and publishing.
 * @module    modules/gradebook/gradebookController
 * @requires  Enrollment, CourseOffering, User, Settings, Assessment, Submission models
 * @audit     D-12: Absolute rebuild pattern for GPA/credits
 *            D-13: Level promotion based on earnedCredits
 *            D-14: Dynamic grade thresholds (no hardcoded values)
 *            D-25: Concurrent publish warning documented
 *            D-26: No college_id filter for GPA (single university)
 *            D-27: UniversityAdmin unlock safety valve
 * ===================================================================================
 */

import Enrollment from "../../../DB/models/enrollmentModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import AttendanceSession from "../../../DB/models/attendanceSessionModel.js";
import User from "../../../DB/models/userModel.js";
import Settings from "../../../DB/models/settingsModel.js";
import Assessment from "../../../DB/models/assessmentModel.js";
import Submission from "../../../DB/models/submissionModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import {
    mapScoreToLetter,
    recalculateAssignmentGrade,
} from "../../utils/gradeUtils.js";

/**
 * Get full gradebook for a course offering
 *
 * Business Logic:
 * 1. Verify course offering exists
 * 2. Fetch all enrolled students (exclude withdrawn)
 * 3. Populate student details and grades
 *
 * @route   GET /api/v1/gradebook/course/:offeringId
 * @access  Doctors, TAs, College Admins
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', results: n, data: { enrollments } }
 * @throws  {AppError} 404 - Course offering not found
 */
export const getCourseGradebook = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;

    // Verify offering exists
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Fetch all enrollments (exclude withdrawn)
    const enrollments = await Enrollment.find({
        course_id: offeringId,
        status: { $ne: "withdrawn" },
    })
        .populate("student_id", "name email level gpa earnedCredits")
        .sort({ "student_id.name": 1 });

    res.status(200).json({
        status: "success",
        results: enrollments.length,
        data: { enrollments },
    });
});

/**
 * Get student's gradebook across all enrolled courses
 *
 * Business Logic:
 * 1. Permission check (students can only see their own)
 * 2. Fetch all enrollments for student
 * 3. Hide finalTotal/finalLetter if resultsPublished = false
 *
 * @route   GET /api/v1/gradebook/student/:studentId
 * @access  Students (self only), Doctors, College Admins
 *
 * @param   {Object} req.params.studentId - Student user ID
 * @param   {Object} req.user - Authenticated user
 *
 * @returns {Object} 200 - { status: 'success', results: n, data: { enrollments } }
 * @throws  {AppError} 403 - Not authorized
 * @throws  {AppError} 404 - Student not found
 */
export const getStudentGradebook = catchAsync(async (req, res, next) => {
    const { studentId } = req.params;

    // Permission check: students can only view their own gradebook
    if (req.user.role === "student" && req.user._id.toString() !== studentId) {
        return next(
            new AppError("Not authorized to view this gradebook.", 403),
        );
    }

    // IDOR Restrict Cross-College Viewing
    const query = { student_id: studentId, status: { $ne: "withdrawn" } };
    if (req.user.role !== "student" && req.user.role !== "universityAdmin") {
        query.college_id = req.scopeFilter.college_id;
    }

    // Fetch all enrollments
    const enrollments = await Enrollment.find(query)
        .populate("course_id", "resultsPublished")
        .populate({
            path: "course_id",
            populate: { path: "course_id", select: "courseCode courseTitle" },
        })
        .sort({ createdAt: -1 });

    // Hide final grades if not published
    const sanitizedEnrollments = enrollments.map((enrollment) => {
        const enrollmentObj = enrollment.toObject();

        if (!enrollment.course_id.resultsPublished) {
            delete enrollmentObj.grades.finalTotal;
            delete enrollmentObj.grades.finalLetter;
        }

        return enrollmentObj;
    });

    res.status(200).json({
        status: "success",
        results: sanitizedEnrollments.length,
        data: { enrollments: sanitizedEnrollments },
    });
});

/**
 * Bulk update semester work grades (attendance, midterm, project)
 *
 * Business Logic:
 * 1. Verify offering exists and doctor has access
 * 2. Check semesterWorkLocked = false (editing allowed)
 * 3. Validate score ranges against gradingPolicy
 * 4. Verify all students are enrolled
 * 5. Bulk update grades
 *
 * @route   PATCH /api/v1/gradebook/course/:offeringId/semester-work
 * @access  Doctors (assigned to course)
 * @body    { grades: [{ studentId, attendance?, midterm?, project? }] }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.body.grades - Array of grade updates
 * @param   {Object} req.user - Authenticated doctor
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { updated: n } }
 * @throws  {AppError} 403 - Semester work is locked
 * @throws  {AppError} 403 - Not authorized (doctor not assigned)
 * @throws  {AppError} 400 - Score validation errors
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   D-20: Validates enrollment, updates assignments via recalc
 */
export const updateSemesterWork = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    const { grades } = req.body;

    // Step 1: Fetch offering with IDOR guard
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Doctor authorization check
    if (!offering.doctors_ids.includes(req.user._id)) {
        return next(
            new AppError(
                "You do not have permission to perform this action.",
                403,
            ),
        );
    }

    // Step 3: Lock guard
    if (offering.semesterWorkLocked) {
        return next(
            new AppError(
                "Semester work is locked. grades cannot be modified.",
                403,
            ),
        );
    }

    // Step 4: Validate score ranges
    for (const gradeData of grades) {
        if (gradeData.attendance !== undefined) {
            if (gradeData.attendance < 0) {
                return next(new AppError("Score cannot be negative.", 400));
            }
            if (gradeData.attendance > offering.gradingPolicy.attendance) {
                return next(
                    new AppError(
                        `Score ${gradeData.attendance} exceeds attendance maximum of ${offering.gradingPolicy.attendance}.`,
                        400,
                    ),
                );
            }
        }

        if (gradeData.midterm !== undefined) {
            if (gradeData.midterm < 0) {
                return next(new AppError("Score cannot be negative.", 400));
            }
            if (gradeData.midterm > offering.gradingPolicy.midterm) {
                return next(
                    new AppError(
                        `Score ${gradeData.midterm} exceeds midterm maximum of ${offering.gradingPolicy.midterm}.`,
                        400,
                    ),
                );
            }
        }

        if (gradeData.project !== undefined) {
            if (gradeData.project < 0) {
                return next(new AppError("Score cannot be negative.", 400));
            }
            if (gradeData.project > offering.gradingPolicy.project) {
                return next(
                    new AppError(
                        `Score ${gradeData.project} exceeds project maximum of ${offering.gradingPolicy.project}.`,
                        400,
                    ),
                );
            }
        }
    }

    // Step 5: Enrollment guard
    const studentIds = grades.map((g) => g.studentId);
    const enrollments = await Enrollment.find({
        student_id: { $in: studentIds },
        course_id: offeringId,
        status: "enrolled",
    }).select("student_id");

    const enrolledIds = enrollments.map((e) => e.student_id.toString());
    const missing = studentIds.filter(
        (id) => !enrolledIds.includes(id.toString()),
    );

    if (missing.length > 0) {
        return next(
            new AppError(
                `Student(s) ${missing.join(", ")} are not enrolled in this offering.`,
                400,
            ),
        );
    }

    // CRIT-5: If fingerprint attendance sessions exist for this offering, block manual
    // attendance grade entry. Attendance is automatically managed by the Phase 5
    // fingerprint attendance system; manual entry would corrupt recalculated percentages.
    // NOTE: Only attendance updates are blocked — midterm and project updates proceed normally.
    const hasAttendanceUpdate = grades.some((g) => g.attendance !== undefined);
    if (hasAttendanceUpdate) {
        const sessionCount = await AttendanceSession.countDocuments({
            courseOffering_id: offeringId,
        });
        if (sessionCount > 0) {
            return next(
                new AppError(
                    'Attendance grades are managed automatically by the fingerprint attendance system. Manual entry is blocked.',
                    400,
                ),
            );
        }
    }

    // Step 6: Bulk write
    const bulkOps = grades.map((gradeData) => {
        const updateFields = {};
        if (gradeData.attendance !== undefined)
            updateFields["grades.attendance"] = gradeData.attendance;
        if (gradeData.midterm !== undefined)
            updateFields["grades.midterm"] = gradeData.midterm;
        if (gradeData.project !== undefined)
            updateFields["grades.project"] = gradeData.project;

        return {
            updateOne: {
                filter: {
                    student_id: gradeData.studentId,
                    course_id: offeringId,
                    status: "enrolled",
                },
                update: { $set: updateFields },
            },
        };
    });

    await Enrollment.bulkWrite(bulkOps);

    res.status(200).json({
        status: "success",
        data: { updated: grades.length },
    });
});

/**
 * Lock semester work (enable final exam entry)
 *
 * Business Logic:
 * 1. Verify offering exists and doctor has access
 * 2. Check not already locked
 * 3. Ghost submission lazy eval: Force-submit ALL in_progress submissions
 * 4. Auto-grade objective questions in ghost submissions
 * 5. Recalculate assignment grades for affected students
 * 6. Set semesterWorkLocked = true
 *
 * @route   POST /api/v1/gradebook/course/:offeringId/lock-semester-work
 * @access  Doctors (assigned to course)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.user - Authenticated doctor
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { message, ghostSubmissionsProcessed } }
 * @throws  {AppError} 400 - Already locked
 * @throws  {AppError} 403 - Not authorized
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   D-11: Ghost submission lazy evaluation at lock time
 */
export const lockSemesterWork = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;

    // Step 1: Fetch offering
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Doctor authorization
    if (!offering.doctors_ids.includes(req.user._id)) {
        return next(
            new AppError(
                "You do not have permission to perform this action.",
                403,
            ),
        );
    }

    // Step 3: Already locked guard
    if (offering.semesterWorkLocked) {
        return next(new AppError("Semester work is already locked.", 400));
    }

    // Step 4: Ghost submission lazy evaluation
    let ghostCount = 0;

    // Fetch all assessments for this offering
    const assessments = await Assessment.find({
        courseOffering_id: offeringId,
    }).select("+questions.options.isCorrect"); // Include answer keys for grading

    // For each assessment, force-submit all in_progress submissions
    for (const assessment of assessments) {
        const inProgressSubs = await Submission.find({
            assessment_id: assessment._id,
            status: "in_progress",
        });

        for (const submission of inProgressSubs) {
            // Auto-grade objective questions with saved answers
            await autoGradeGhostSubmission(submission, assessment);

            // Determine if all questions are auto-gradable
            const hasManualQuestions = assessment.questions.some((q) =>
                ["Short-Answer", "Paragraph", "FileUpload"].includes(
                    q.questionType,
                ),
            );

            submission.status = hasManualQuestions ? "submitted" : "graded";
            submission.submittedAt = new Date();

            await submission.save();
            ghostCount++;

            // CRIT-5: recalculateAssignmentGrade writes to enrollment internally
            if (submission.status === "graded") {
                await recalculateAssignmentGrade(
                    submission.student_id,
                    offeringId,
                );
            }
        }
    }

    // Step 5: Lock the offering
    offering.semesterWorkLocked = true;
    await offering.save();

    res.status(200).json({
        status: "success",
        data: {
            message:
                "Semester work locked. Final exam grades can now be entered by the college admin.",
            ghostSubmissionsProcessed: ghostCount,
        },
    });
});

/**
 * Helper: Auto-grade ghost submission (same logic as submit)
 * @private
 */
async function autoGradeGhostSubmission(submission, assessment) {
    let totalScore = 0;

    submission.answers.forEach((answer) => {
        const question = assessment.questions.id(answer.questionId);
        if (!question) return;

        let score = 0;

        switch (question.questionType) {
            case "MCQ-Single":
                if (answer.selectedOptionId) {
                    const selectedOption = question.options.id(
                        answer.selectedOptionId,
                    );
                    if (selectedOption && selectedOption.isCorrect) {
                        score = question.points;
                    }
                }
                break;

            case "MCQ-Multiple":
                if (
                    answer.selectedOptionIds &&
                    answer.selectedOptionIds.length > 0
                ) {
                    const correctOptionIds = question.options
                        .filter((opt) => opt.isCorrect)
                        .map((opt) => opt._id.toString());

                    const selectedIds = answer.selectedOptionIds.map((id) =>
                        id.toString(),
                    );

                    const isCorrect =
                        correctOptionIds.length === selectedIds.length &&
                        correctOptionIds.every((id) =>
                            selectedIds.includes(id),
                        );

                    if (isCorrect) {
                        score = question.points;
                    }
                }
                break;

            case "TrueFalse":
                if (answer.answerText) {
                    const selectedOption = question.options.find(
                        (opt) =>
                            opt.text.toLowerCase() ===
                            answer.answerText.toLowerCase(),
                    );
                    if (selectedOption && selectedOption.isCorrect) {
                        score = question.points;
                    }
                }
                break;

            // CRIT-4: Short-Answer, Paragraph, FileUpload require manual grading
            case "Short-Answer":
            case "Paragraph":
            case "FileUpload":
                score = 0;
                answer.feedback = "Pending manual review";
                break;

            default:
                score = 0;
        }

        answer.score = score;
        totalScore += score;
    });

    submission.totalScore = totalScore;
}

/**
 * Unlock semester work (safety valve)
 *
 * Business Logic:
 * 1. Verify offering exists
 * 2. Check currently locked
 * 3. Check results not yet published (hard block)
 * 4. Unlock offering
 *
 * @route   POST /api/v1/gradebook/course/:offeringId/unlock-semester-work
 * @access  University Admin and College Admin
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.user - Authenticated doctor
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { message } }
 * @throws  {AppError} 400 - Not locked
 * @throws  {AppError} 403 - Results already published
 * @throws  {AppError} 403 - Not authorized
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   D-27: Safety valve for pre-publish corrections
 */
export const unlockSemesterWork = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;

    // Step 1: Fetch offering
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Already unlocked guard
    if (!offering.semesterWorkLocked) {
        return next(new AppError("Semester work is not locked.", 400));
    }

    // Step 3: Publish guard (hard block)
    if (offering.resultsPublished) {
        return next(
            new AppError(
                "Results have already been published. Semester work cannot be unlocked.",
                403,
            ),
        );
    }

    // DEBT-4: Audit Log (D-27) - Record unlock event
    console.warn(
        `[AUDIT] Semester work UNLOCKED by ${req.user.role} (${req.user._id}) for offering ${offeringId}`,
    );
    // TODO: Replace with AuditLog.create() once the AuditLog model is implemented
    // await AuditLog.create({ actor_id: req.user._id, action: 'GRADEBOOK_UNLOCK', targetId: offeringId });
    // Step 4: Unlock
    offering.semesterWorkLocked = false;
    await offering.save();

    res.status(200).json({
        status: "success",
        data: {
            message: "Semester work unlocked. Grades can be modified again.",
        },
    });
});

/**
 * Bulk update final exam grades
 *
 * Business Logic:
 * 1. Verify offering exists
 * 2. Check semesterWorkLocked = true (required before final exam)
 * 3. Check resultsPublished = false (cannot edit after publish)
 * 4. Validate score ranges
 * 5. Verify all students enrolled
 * 6. Bulk update final exam grades
 *
 * @route   PATCH /api/v1/gradebook/course/:offeringId/final-exam
 * @access  College Admins
 * @body    { grades: [{ studentId, finalExam }] }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.body.grades - Array of final exam grades
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { updated: n } }
 * @throws  {AppError} 403 - Semester work must be locked first
 * @throws  {AppError} 403 - Results already published
 * @throws  {AppError} 400 - Score validation errors
 * @throws  {AppError} 404 - Course offering not found
 */
export const updateFinalExam = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    const { grades } = req.body;

    // Step 1: Fetch offering with IDOR guard
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Lock guard (inverted - must be locked)
    if (!offering.semesterWorkLocked) {
        return next(
            new AppError(
                "Semester work must be locked before entering final exam grades.",
                403,
            ),
        );
    }

    // Step 3: Publish guard
    if (offering.resultsPublished) {
        return next(
            new AppError(
                "Results are already published. Final exam grades cannot be changed.",
                403,
            ),
        );
    }

    // Step 4: Validate score ranges
    for (const gradeData of grades) {
        if (gradeData.finalExam < 0) {
            return next(new AppError("Score cannot be negative.", 400));
        }
        if (gradeData.finalExam > offering.gradingPolicy.finalExam) {
            return next(
                new AppError(
                    `Score ${gradeData.finalExam} exceeds final exam maximum of ${offering.gradingPolicy.finalExam}.`,
                    400,
                ),
            );
        }
    }

    // Step 5: Enrollment guard
    const studentIds = grades.map((g) => g.studentId);
    const enrollments = await Enrollment.find({
        student_id: { $in: studentIds },
        course_id: offeringId,
        status: "enrolled",
    }).select("student_id");

    const enrolledIds = enrollments.map((e) => e.student_id.toString());
    const missing = studentIds.filter(
        (id) => !enrolledIds.includes(id.toString()),
    );

    if (missing.length > 0) {
        return next(
            new AppError(
                `Student(s) ${missing.join(", ")} are not enrolled in this offering.`,
                400,
            ),
        );
    }

    // Step 6: Bulk write
    const bulkOps = grades.map((gradeData) => ({
        updateOne: {
            filter: {
                student_id: gradeData.studentId,
                course_id: offeringId,
                status: "enrolled",
            },
            update: { $set: { "grades.finalExam": gradeData.finalExam } },
        },
    }));

    await Enrollment.bulkWrite(bulkOps);

    res.status(200).json({
        status: "success",
        data: { updated: grades.length },
    });
});

/**
 * Publish gradebook results (GPA calculation pipeline)
 *
 * Business Logic:
 * 1. Verify offering exists and semesterWorkLocked = true
 * 2. Fetch Settings (gradePoints, gradeThresholds, levelThresholds)
 * 3. For each enrollment:
 *    a. Calculate finalTotal (sum of all components)
 *    b. Map to finalLetter (dynamic thresholds)
 *    c. Set status (passed/failed)
 *    d. Save enrollment
 * 4. For each unique student:
 *    a. Absolute rebuild: Calculate earnedCredits (sum of passed courses)
 *    b. Absolute rebuild: Calculate GPA (weighted average across ALL enrollments)
 *    c. Level promotion: Determine level based on earnedCredits
 *    d. Update User document
 * 5. Set resultsPublished = true
 *
 * @route   POST /api/v1/gradebook/course/:offeringId/publish
 * @access  College Admins
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { message, published, passed, failed } }
 * @throws  {AppError} 403 - Semester work must be locked
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   D-12: Absolute rebuild pattern
 *          D-13: Level promotion logic
 *          D-14: Dynamic grade thresholds
 *          D-25: Concurrent publish warning
 *          D-26: No college_id filter for cumulative GPA
 */
export const publishGradebook = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;

    // Step 1: Fetch offering with IDOR guard
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    }).populate("course_id", "creditHours");

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Lock guard
    if (!offering.semesterWorkLocked) {
        return next(
            new AppError(
                "Semester work must be locked before publishing results.",
                403,
            ),
        );
    }

    // Step 3: Fetch Settings
    const settings = await Settings.getSettings();
    const gradePoints = settings.gradePoints;
    const gradeThresholds = settings.gradeThresholds;
    const levelThresholds = settings.levelThresholds;

    // Step 4: Fetch all enrolled students
    const enrollments = await Enrollment.find({
        course_id: offeringId,
        status: "enrolled",
    });

    // Step 5: Per-enrollment grade computation
    let passedCount = 0;
    let failedCount = 0;

    for (const enrollment of enrollments) {
        // a. Compute finalTotal
        const finalTotal =
            (enrollment.grades.attendance || 0) +
            (enrollment.grades.midterm || 0) +
            (enrollment.grades.assignments || 0) +
            (enrollment.grades.project || 0) +
            (enrollment.grades.finalExam || 0);

        // b. Map to finalLetter
        const finalLetter = mapScoreToLetter(
            finalTotal,
            offering.totalDegree,
            gradeThresholds,
        );

        // c. Determine status
        const enrollmentStatus = finalLetter === "F" ? "failed" : "passed";

        // d. Write enrollment
        enrollment.grades.finalTotal = finalTotal;
        enrollment.grades.finalLetter = finalLetter;
        enrollment.status = enrollmentStatus;
        await enrollment.save();

        if (enrollmentStatus === "passed") passedCount++;
        else failedCount++;
    }

    // Step 6: Collect unique student IDs
    const studentIds = [
        ...new Set(enrollments.map((e) => e.student_id.toString())),
    ];

    // Step 7: Per-student absolute rebuild
    for (const studentId of studentIds) {
        // a. Fetch ALL enrollments for this student (no college_id filter - D-26)
        const allEnrollments = await Enrollment.find({
            student_id: studentId,
            status: { $in: ["passed", "failed"] },
        }).select("status snapshot.creditHours grades.finalLetter");

        // b. Absolute rebuild - earned credits
        const earnedCredits = allEnrollments
            .filter((e) => e.status === "passed")
            .reduce((sum, e) => sum + (e.snapshot?.creditHours || 0), 0);

        // c. Absolute rebuild - GPA
        const gpaEnrollments = allEnrollments.filter(
            (e) =>
                e.grades.finalLetter && gradePoints.has(e.grades.finalLetter),
        );

        const totalWeighted = gpaEnrollments.reduce((sum, e) => {
            const points = gradePoints.get(e.grades.finalLetter) || 0;
            const credits = e.snapshot?.creditHours || 0;
            return sum + points * credits;
        }, 0);

        const totalAttempted = gpaEnrollments.reduce(
            (sum, e) => sum + (e.snapshot?.creditHours || 0),
            0,
        );

        const gpa =
            totalAttempted > 0
                ? Math.round((totalWeighted / totalAttempted) * 100) / 100
                : 0.0;

        // d. Level promotion
        const sortedLevels = Array.from(levelThresholds.entries()).sort(
            (a, b) => b[1] - a[1],
        ); // Sort descending by threshold

        const newLevel = Number(
            sortedLevels.find(
                ([, threshold]) => earnedCredits >= threshold,
            )?.[0] || 1,
        );

        // e. Determine academic status
        let academicStatus = "good_standing";
        if (gpa < 2.0) {
            academicStatus = "probation";
        } else if (gpa >= 3.5) {
            academicStatus = "honors";
        }

        // f. Atomic write to User
        await User.findByIdAndUpdate(studentId, {
            gpa,
            earnedCredits,
            level: newLevel,
            academicStatus,
        });
    }

    // Step 8: Set resultsPublished flag
    offering.resultsPublished = true;
    await offering.save();

    res.status(200).json({
        status: "success",
        data: {
            message: "Results published successfully.",
            published: enrollments.length,
            passed: passedCount,
            failed: failedCount,
        },
    });
});

/**
 * Get student's own grades for a specific course offering
 *
 * Business Logic:
 * 1. Verify student is enrolled in the offering
 * 2. Return enrollment grades
 * 3. Strip finalTotal/finalLetter if resultsPublished = false
 *
 * @route   GET /api/v1/gradebook/course/:offeringId/my
 * @access  Students (enrolled in offering)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.user - Authenticated student
 *
 * @returns {Object} 200 - { status: 'success', data: { enrollment } }
 * @throws  {AppError} 404 - Course offering or enrollment not found
 *
 * @audit   CRIT-10: Missing endpoint from Plan Section 17
 */
export const getMyGrades = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    const studentId = req.user._id;

    // Verify offering exists
    const offering = await CourseOffering.findById(offeringId);
    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Fetch student's enrollment
    const enrollment = await Enrollment.findOne({
        student_id: studentId,
        course_id: offeringId,
        status: { $ne: "withdrawn" },
    });

    if (!enrollment) {
        return next(new AppError("You are not enrolled in this course.", 404));
    }

    // Strip final grades if results not published
    const enrollmentObj = enrollment.toObject();
    if (!offering.resultsPublished) {
        delete enrollmentObj.grades.finalTotal;
        delete enrollmentObj.grades.finalLetter;
    }

    res.status(200).json({
        status: "success",
        data: { enrollment: enrollmentObj },
    });
});

/**
 * Admin tool: Rebuild a student's GPA from scratch
 *
 * Business Logic:
 * 1. Fetch ALL enrollments for the student (no college_id filter - D-26)
 * 2. Absolute rebuild of earnedCredits, GPA, level, academicStatus
 * 3. Write to User document
 *
 * This is the designated recovery tool for the concurrent publish
 * race condition documented in D-25.
 *
 * @route   POST /api/v1/gradebook/admin/students/:studentId/rebuild-gpa
 * @access  University Admin only
 *
 * @param   {Object} req.params.studentId - Student user ID
 *
 * @returns {Object} 200 - { status: 'success', data: { gpa, earnedCredits, level, academicStatus } }
 * @throws  {AppError} 404 - Student not found
 *
 * @audit   D-25: Concurrent publish recovery tool
 *          D-26: No college_id filter for cumulative GPA
 */
export const rebuildStudentGpa = catchAsync(async (req, res, next) => {
    const { studentId } = req.params;

    // Verify student exists
    const student = await User.findById(studentId);
    if (!student || student.role !== "student") {
        return next(new AppError("Student not found.", 404));
    }

    // Fetch Settings
    const settings = await Settings.getSettings();
    const gradePoints = settings.gradePoints;
    const levelThresholds = settings.levelThresholds;

    // Fetch ALL enrollments (no college_id filter - D-26)
    const allEnrollments = await Enrollment.find({
        student_id: studentId,
        status: { $in: ["passed", "failed"] },
    }).select("status snapshot.creditHours grades.finalLetter");

    // Absolute rebuild - earned credits
    const earnedCredits = allEnrollments
        .filter((e) => e.status === "passed")
        .reduce((sum, e) => sum + (e.snapshot?.creditHours || 0), 0);

    // Absolute rebuild - GPA
    const gpaEnrollments = allEnrollments.filter(
        (e) => e.grades.finalLetter && gradePoints.has(e.grades.finalLetter),
    );

    const totalWeighted = gpaEnrollments.reduce((sum, e) => {
        const points = gradePoints.get(e.grades.finalLetter) || 0;
        const credits = e.snapshot?.creditHours || 0;
        return sum + points * credits;
    }, 0);

    const totalAttempted = gpaEnrollments.reduce(
        (sum, e) => sum + (e.snapshot?.creditHours || 0),
        0,
    );

    const gpa =
        totalAttempted > 0
            ? Math.round((totalWeighted / totalAttempted) * 100) / 100
            : 0.0;

    // Level promotion
    const sortedLevels = Array.from(levelThresholds.entries()).sort(
        (a, b) => b[1] - a[1],
    );

    const newLevel = Number(
        sortedLevels.find(([, threshold]) => earnedCredits >= threshold)?.[0] ||
            1,
    );

    // Academic status
    let academicStatus = "good_standing";
    if (gpa < 2.0) {
        academicStatus = "probation";
    } else if (gpa >= 3.5) {
        academicStatus = "honors";
    }

    // Atomic write to User
    await User.findByIdAndUpdate(studentId, {
        gpa,
        earnedCredits,
        level: newLevel,
        academicStatus,
    });

    res.status(200).json({
        status: "success",
        data: {
            message: "Student GPA rebuilt successfully.",
            gpa,
            earnedCredits,
            level: newLevel,
            academicStatus,
        },
    });
});
