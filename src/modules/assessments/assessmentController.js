/**
 * ===================================================================================
 * @file      assessmentController.js
 * @desc      Controller for assessment management and student access workflows.
 *            Handles CRUD, question security, shuffling, and assessment start.
 * @module    modules/assessment/assessmentController
 * @requires  Assessment, Submission, CourseOffering, Enrollment models
 * @audit     HIGH-3: Uses findById → mutate → save() for question updates
 *            MED-3: Never exposes isCorrect/modelAnswer to students
 *            D-21: Seeded shuffle for consistent student experience
 * ===================================================================================
 */

import Assessment from "../../../DB/models/assessmentModel.js";
import Submission from "../../../DB/models/submissionModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import { seededShuffle } from "../../utils/shuffleUtils.js";
import { deleteFromCloudinary } from "../../utils/uploadHelper.js";

/**
 * Create a new assessment
 *
 * Business Logic:
 * 1. Verify course offering exists and belongs to user's college
 * 2. Denormalize college_id from course offering
 * 3. Create assessment (totalPoints auto-calculated by pre-save hook)
 *
 * @route   POST /api/v1/offerings/:offeringId/assessments
 * @access  Doctors & TAs (assigned to course)
 * @body    { title, description, dueDate, timeLimitMinutes?, questions[], settings? }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.body - Assessment data
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 201 - { status: 'success', data: { assessment } }
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   GAP-2C: totalPoints auto-calculated by pre-save hook
 */
export const createAssessment = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    const {
        title,
        description,
        dueDate,
        timeLimitMinutes,
        questions,
        settings,
        doctorDeclaredTotal,
    } = req.body;

    // Step 1: Verify course offering exists
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // CRIT-1: Doctor authorization — only assigned doctors can create (D-18)
    if (
        !offering.doctors_ids.some(
            (id) => id.toString() === req.user._id.toString(),
        )
    ) {
        return next(
            new AppError(
                "You do not have permission to perform this action.",
                403,
            ),
        );
    }

    // CRIT-2: Question Validation (Plan Section 11, Step 4)
    if (questions && questions.length > 0) {
        for (const q of questions) {
            if (
                ["MCQ-Single", "MCQ-Multiple", "TrueFalse"].includes(
                    q.questionType,
                )
            ) {
                if (!q.options || q.options.length === 0)
                    return next(
                        new AppError(
                            "Objective questions must have options.",
                            400,
                        ),
                    );
                if (!q.options.some((opt) => opt.isCorrect))
                    return next(
                        new AppError(
                            "Objective questions must have at least one correct option.",
                            400,
                        ),
                    );
            } else if (
                ["Short-Answer", "Paragraph", "FileUpload"].includes(
                    q.questionType,
                )
            ) {
                if (q.options && q.options.length > 0)
                    return next(
                        new AppError(
                            "Subjective questions cannot have options.",
                            400,
                        ),
                    );
            }
            if (!q.points || q.points <= 0)
                return next(new AppError("Question points must be > 0.", 400));
        }
    }

    // D-3 Guard: Mathematical Total Constraint Validation
    if (
        questions &&
        questions.length > 0 &&
        doctorDeclaredTotal !== undefined
    ) {
        const calculatedTotal = questions.reduce(
            (sum, q) => sum + (q.points || 0),
            0,
        );
        if (doctorDeclaredTotal !== calculatedTotal) {
            return next(
                new AppError(
                    `Total points mismatch: declared ${doctorDeclaredTotal}, calculated ${calculatedTotal}.`,
                    400,
                ),
            );
        }
    }

    // Step 2: Create assessment with denormalized college_id
    const assessment = await Assessment.create({
        title,
        description,
        courseOffering_id: offeringId,
        college_id: offering.college_id, // Denormalized for tenant isolation
        dueDate,
        timeLimitMinutes: timeLimitMinutes || null,
        questions: questions || [],
        settings: settings || {},
    });
    // Note: totalPoints is auto-calculated by pre-save hook

    res.status(201).json({
        status: "success",
        data: { assessment },
    });
});

/**
 * Get all assessments for a course offering
 *
 * Business Logic:
 * 1. Verify course offering exists
 * 2. Fetch assessments (pre-find hook auto-filters archived)
 * 3. Security: Exclude isCorrect and modelAnswer fields from response
 *
 * @route   GET /api/v1/offerings/:offeringId/assessments
 * @access  Doctors, TAs, Students (enrolled), College Admins
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', results: n, data: { assessments } }
 * @throws  {AppError} 404 - Course offering not found
 *
 * @audit   MED-3: Excludes sensitive answer fields via select: false
 */
export const getAllAssessments = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;

    // Step 1: Verify course offering exists
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Fetch assessments (isArchived: false auto-applied)
    const assessments = await Assessment.find({
        courseOffering_id: offeringId,
        college_id: offering.college_id,
    }).sort({ dueDate: 1 }); // Earliest due date first

    // Note: isCorrect and modelAnswer are excluded via select: false in schema

    res.status(200).json({
        status: "success",
        results: assessments.length,
        data: { assessments },
    });
});

/**
 * Get a single assessment by ID
 *
 * Business Logic:
 * 1. Fetch assessment with tenant isolation
 * 2. Verify belongs to specified course offering
 * 3. Security: Answer keys excluded via select: false
 *
 * @route   GET /api/v1/offerings/:offeringId/assessments/:id
 * @access  Doctors, TAs, Students (enrolled), College Admins
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Assessment ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { assessment } }
 * @throws  {AppError} 404 - Assessment not found
 */
export const getAssessment = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;

    // Fetch with tenant isolation and offering validation
    const assessment = await Assessment.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!assessment) {
        return next(new AppError("Assessment not found.", 404));
    }

    res.status(200).json({
        status: "success",
        data: { assessment },
    });
});

/**
 * Update an assessment
 *
 * Business Logic:
 * 1. Fetch assessment with tenant isolation
 * 2. Update fields (metadata, questions, settings)
 * 3. CRITICAL: Use doc.save() pattern (not findByIdAndUpdate)
 * 4. Pre-save hook auto-recalculates totalPoints if questions modified
 *
 * @route   PATCH /api/v1/offerings/:offeringId/assessments/:id
 * @access  Doctors & TAs (assigned to course)
 * @body    { title?, description?, dueDate?, timeLimitMinutes?, questions?, settings? }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Assessment ID
 * @param   {Object} req.body - Update data
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { assessment } }
 * @throws  {AppError} 404 - Assessment not found
 *
 * @audit   HIGH-3: MUST use findById → mutate → save() pattern
 *          Using findByIdAndUpdate bypasses pre-save hook and breaks totalPoints sync
 */
export const updateAssessment = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;
    const {
        title,
        description,
        dueDate,
        timeLimitMinutes,
        questions,
        settings,
        doctorDeclaredTotal,
    } = req.body;

    // Step 1: Fetch assessment (findById for save() pattern)
    const assessment = await Assessment.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!assessment) {
        return next(new AppError("Assessment not found.", 404));
    }

    const submissionsExist = await Submission.exists({ assessment_id: id });
    if (submissionsExist && questions !== undefined) {
        return next(
            new AppError(
                "Cannot edit an assessment that has active submissions.",
                400,
            ),
        );
    }

    // Validation: Questions Payload & Doctor Declared Total
    if (questions && questions.length > 0) {
        for (const q of questions) {
            if (
                ["MCQ-Single", "MCQ-Multiple", "TrueFalse"].includes(
                    q.questionType,
                )
            ) {
                if (!q.options || q.options.length === 0)
                    return next(
                        new AppError(
                            "Objective questions must have options.",
                            400,
                        ),
                    );
                if (!q.options.some((opt) => opt.isCorrect))
                    return next(
                        new AppError(
                            "Objective questions must have at least one correct option.",
                            400,
                        ),
                    );
            } else if (
                ["Short-Answer", "Paragraph", "FileUpload"].includes(
                    q.questionType,
                )
            ) {
                if (q.options && q.options.length > 0)
                    return next(
                        new AppError(
                            "Subjective questions cannot have options.",
                            400,
                        ),
                    );
            }
            if (!q.points || q.points <= 0)
                return next(new AppError("Question points must be > 0.", 400));
        }

        if (doctorDeclaredTotal !== undefined) {
            const calculatedTotal = questions.reduce(
                (sum, q) => sum + (q.points || 0),
                0,
            );
            if (doctorDeclaredTotal !== calculatedTotal) {
                return next(
                    new AppError(
                        `Total points mismatch: declared ${doctorDeclaredTotal}, calculated ${calculatedTotal}.`,
                        400,
                    ),
                );
            }
        }
    }

    // Step 2: Extract current attachments to prevent Orphaned File Leaks
    let orphanedAttachments = [];
    if (questions !== undefined) {
        const oldAttachments = assessment.questions.flatMap(
            (q) => q.attachments || [],
        );
        const newAttachments = questions.flatMap((q) => q.attachments || []);

        // Find attachments present in old array but missing in new (orphaned)
        orphanedAttachments = oldAttachments.filter(
            (oldUrl) => !newAttachments.includes(oldUrl),
        );

        assessment.questions = questions;
    }

    // Mutate remaining document fields
    if (title !== undefined) assessment.title = title;
    if (description !== undefined) assessment.description = description;
    if (dueDate !== undefined) assessment.dueDate = dueDate;
    if (timeLimitMinutes !== undefined)
        assessment.timeLimitMinutes = timeLimitMinutes;
    if (settings !== undefined)
        assessment.settings = { ...assessment.settings, ...settings };

    // Fire & Forget Cloudinary deletions for orphaned attachments
    if (orphanedAttachments.length > 0) {
        orphanedAttachments.forEach((url) => {
            deleteFromCloudinary(url).catch((err) => {
                console.warn(
                    `[WARNING] Failed to delete orphaned assessment attachment: ${url}`,
                );
            });
        });
    }

    // Step 3: Save (triggers pre-save hook to recalculate totalPoints)
    await assessment.save();

    res.status(200).json({
        status: "success",
        data: { assessment },
    });
});

/**
 * Delete an assessment (soft delete)
 *
 * Business Logic:
 * 1. Fetch assessment with tenant isolation
 * 2. Set isArchived = true (soft delete)
 * 3. Pre-find hook will auto-filter this assessment from future queries
 *
 * @route   DELETE /api/v1/offerings/:offeringId/assessments/:id
 * @access  Doctors & TAs (assigned to course)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Assessment ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 204 - No content
 * @throws  {AppError} 404 - Assessment not found
 *
 * @audit   GAP-2B: Pre-find hook auto-filters archived assessments
 */
export const deleteAssessment = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;

    // Fetch assessment
    const assessment = await Assessment.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!assessment) {
        return next(new AppError("Assessment not found.", 404));
    }

    const submissionsExist = await Submission.exists({ assessment_id: id });
    if (submissionsExist) {
        return next(
            new AppError(
                "Cannot delete an assessment that has active submissions.",
                400,
            ),
        );
    }

    // Soft delete
    assessment.isArchived = true;
    await assessment.save();

    res.status(204).json(null);
});

/**
 * Start an assessment (student workflow)
 *
 * Business Logic:
 * 1. Verify assessment exists and student is enrolled
 * 2. Check if accepting responses
 * 3. Find or create submission:
 *    - If first access: Create submission with startedAt = now
 *    - If returning: Load existing submission
 * 4. Apply shuffling (if enabled):
 *    - Shuffle questions using seededShuffle(questions, studentId)
 *    - Shuffle options using seededShuffle(options, studentId + questionId)
 * 5. Calculate timer deadline (if timed)
 * 6. Return assessment data WITHOUT answer keys
 *
 * @route   GET /api/v1/offerings/:offeringId/assessments/:id/start
 * @access  Students (enrolled in course)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Assessment ID
 * @param   {Object} req.user - Authenticated student
 *
 * @returns {Object} 200 - { status: 'success', data: { assessment, submission, deadline? } }
 * @throws  {AppError} 403 - Assessment is not accepting responses
 * @throws  {AppError} 403 - You are not enrolled in this course
 * @throws  {AppError} 404 - Assessment not found
 *
 * @audit   D-4: Sets startedAt on first access for timer enforcement
 * @audit   D-21: Seeded shuffle ensures consistent order across requests
 */
export const startAssessment = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;
    const studentId = req.user._id;

    // Step 1: Fetch assessment (without answer keys)
    const assessment = await Assessment.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!assessment) {
        return next(new AppError("Assessment not found.", 404));
    }

    // Step 2: Check if accepting responses
    if (!assessment.settings.acceptingResponses) {
        return next(
            new AppError("This assessment is not accepting responses.", 400),
        );
    }

    // CRIT-6: dueDate guard (Plan Section 11, Step 2)
    if (assessment.dueDate && new Date() > assessment.dueDate) {
        return next(
            new AppError("The deadline for this assessment has passed.", 400),
        );
    }

    // Step 3: Verify student is enrolled in course
    const enrollment = await Enrollment.findOne({
        student_id: studentId,
        course_id: offeringId,
        status: "enrolled",
    });

    if (!enrollment) {
        return next(new AppError("You are not enrolled in this course.", 403));
    }

    // Step 4: Find or create submission
    let submission = await Submission.findOne({
        assessment_id: id,
        student_id: studentId,
        college_id: req.scopeFilter.college_id,
    });

    if (!submission) {
        // First access: Create submission with startedAt timestamp
        submission = await Submission.create({
            assessment_id: id,
            student_id: studentId,
            courseOffering_id: offeringId,
            college_id: assessment.college_id,
            startedAt: new Date(), // Timer anchor
            status: "in_progress",
            answers: [],
        });
    } else if (
        submission.status === "submitted" ||
        submission.status === "graded"
    ) {
        // Already-submitted guard (Plan Step 3)
        return next(
            new AppError("You have already submitted this assessment.", 400),
        );
    }

    // CRIT-6: Timer auto-submit on resume (Plan Step 4, D-5)
    if (
        submission.status === "in_progress" &&
        assessment.timeLimitMinutes &&
        submission.startedAt
    ) {
        const deadline = new Date(
            submission.startedAt.getTime() +
                assessment.timeLimitMinutes * 60000,
        );
        if (new Date() > deadline) {
            submission.status = "submitted";
            submission.submittedAt = new Date();
            await submission.save();
            return res.status(200).json({
                status: "success",
                data: { submission },
                autoSubmitted: true,
            });
        }
    }

    // Step 5: Apply shuffling (if enabled)
    let questionsToReturn = assessment.questions.map((q) => q.toObject());

    // Shuffle questions if enabled
    if (assessment.settings.shuffleQuestions) {
        questionsToReturn = seededShuffle(
            questionsToReturn,
            studentId.toString(),
        );
    }

    // Shuffle options for each question if enabled
    questionsToReturn = questionsToReturn.map((question) => {
        if (
            question.shuffleOptions &&
            question.options &&
            question.options.length > 0
        ) {
            const seed = studentId.toString() + question._id.toString();
            question.options = seededShuffle(question.options, seed);
        }
        return question;
    });

    // Step 6: Calculate timer deadline (if timed)
    let deadline = null;
    if (assessment.timeLimitMinutes && submission.startedAt) {
        deadline = new Date(
            submission.startedAt.getTime() +
                assessment.timeLimitMinutes * 60000,
        );
    }

    // Step 7: Prepare response (strip answer keys)
    const assessmentData = {
        _id: assessment._id,
        title: assessment.title,
        description: assessment.description,
        dueDate: assessment.dueDate,
        totalPoints: assessment.totalPoints,
        timeLimitMinutes: assessment.timeLimitMinutes,
        questions: questionsToReturn.map((q) => ({
            _id: q._id,
            questionText: q.questionText,
            order: q.order,
            attachments: q.attachments,
            questionType: q.questionType,
            isRequired: q.isRequired,
            options: q.options
                ? q.options.map((opt) => ({
                      _id: opt._id,
                      text: opt.text,
                      // isCorrect excluded
                  }))
                : [],
            shuffleOptions: q.shuffleOptions,
            validation: q.validation,
            points: q.points,
            // modelAnswer excluded
        })),
        settings: assessment.settings,
    };

    res.status(200).json({
        status: "success",
        data: {
            assessment: assessmentData,
            submission: {
                _id: submission._id,
                status: submission.status,
                startedAt: submission.startedAt,
                answers: submission.answers,
            },
            deadline,
        },
    });
});
