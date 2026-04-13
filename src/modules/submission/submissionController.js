/**
 * ===================================================================================
 * @file      submissionController.js
 * @desc      Controller for submission management (student answers, grading workflow).
 *            Handles draft saves, auto-grading, manual grading, and timer enforcement.
 * @module    modules/submission/submissionController
 * @requires  Submission, Assessment, Enrollment models, gradeUtils
 * @audit     D-4: Timer expiry handling with force-submit
 *            D-23: Triggers recalculateAssignmentGrade after grading
 * ===================================================================================
 */

import Submission from "../../../DB/models/submissionModel.js";
import Assessment from "../../../DB/models/assessmentModel.js";
import Enrollment from "../../../DB/models/enrollmentModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import { recalculateAssignmentGrade } from "../../utils/gradeUtils.js";

/**
 * Save or update student answers (draft mode)
 *
 * Business Logic:
 * 1. Verify submission exists and belongs to student
 * 2. Check timer expiry:
 *    - If expired: Auto-submit with current answers, return { autoSubmitted: true }
 *    - If not expired: Save draft answers
 * 3. Update submission.answers array (merge with existing)
 *
 * @route   PATCH /api/v1/submissions/:submissionId/answers
 * @access  Students (owner only)
 * @body    { answers: [{ questionId, answerText?, selectedOptionId?, selectedOptionIds?, fileUrl? }] }
 *
 * @param   {Object} req.params.submissionId - Submission ID
 * @param   {Object} req.body.answers - Array of answer objects
 * @param   {Object} req.user - Authenticated student
 *
 * @returns {Object} 200 - { status: 'success', data: { submission }, autoSubmitted? }
 * @throws  {AppError} 403 - Not authorized to modify this submission
 * @throws  {AppError} 403 - Submission already finalized
 * @throws  {AppError} 404 - Submission not found
 *
 * @audit   D-4: Timer expiry check, auto-submit on expiry
 */
export const saveAnswers = catchAsync(async (req, res, next) => {
    const { submissionId } = req.params;
    const { answers } = req.body;
    const studentId = req.user._id;

    // Step 1: Fetch submission with assessment data
    const submission = await Submission.findOne({
        _id: submissionId,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    if (!submission) {
        return next(new AppError("Submission not found.", 404));
    }

    // Step 2: Ownership check
    if (submission.student_id.toString() !== studentId.toString()) {
        return next(
            new AppError("Not authorized to modify this submission.", 403),
        );
    }

    // Step 3: Status check (can only save if in_progress)
    if (submission.status !== "in_progress") {
        return next(new AppError("Submission already finalized.", 403));
    }

    // Step 4: Timer expiry check
    const assessment = await Assessment.findOne({
        _id: submission.assessment_id,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    if (assessment.timeLimitMinutes && submission.startedAt) {
        const deadline = new Date(
            submission.startedAt.getTime() +
                assessment.timeLimitMinutes * 60000,
        );
        const now = new Date();

        if (now > deadline) {
            // Timer expired: Force-submit with current answers
            submission.answers = answers || submission.answers;
            submission.status = "submitted";
            submission.submittedAt = now;

            // Auto-grade objective questions
            await autoGradeSubmission(submission, assessment);
            await submission.save();

            return res.status(200).json({
                status: "success",
                data: { submission },
                autoSubmitted: true,
            });
        }
    }

    // Step 5: Save draft answers (merge with existing)
    if (answers && answers.length > 0) {
        answers.forEach((newAnswer) => {
            const existingIndex = submission.answers.findIndex(
                (a) =>
                    a.questionId.toString() === newAnswer.questionId.toString(),
            );

            if (existingIndex >= 0) {
                // Update existing answer
                submission.answers[existingIndex] = {
                    ...submission.answers[existingIndex].toObject(),
                    ...newAnswer,
                };
            } else {
                // Add new answer
                submission.answers.push(newAnswer);
            }
        });
    }

    await submission.save();

    res.status(200).json({
        status: "success",
        data: { submission },
    });
});

/**
 * Finalize submission (status: in_progress → submitted)
 *
 * Business Logic:
 * 1. Verify submission exists and belongs to student
 * 2. Check timer expiry (if expired, prevent submission)
 * 3. Auto-grade MCQ/TrueFalse questions
 * 4. Update status to 'submitted', set submittedAt timestamp
 *
 * @route   POST /api/v1/submissions/:submissionId/submit
 * @access  Students (owner only)
 *
 * @param   {Object} req.params.submissionId - Submission ID
 * @param   {Object} req.user - Authenticated student
 *
 * @returns {Object} 200 - { status: 'success', data: { submission }, autoSubmitted? }
 * @throws  {AppError} 403 - Timer expired (if past deadline)
 * @throws  {AppError} 403 - Not authorized
 * @throws  {AppError} 403 - Already submitted
 * @throws  {AppError} 404 - Submission not found
 *
 * @audit   D-4: Timer expiry enforcement on submit
 */
export const submitAssessment = catchAsync(async (req, res, next) => {
    const { submissionId } = req.params;
    const studentId = req.user._id;

    // Step 1: Fetch submission
    const submission = await Submission.findOne({
        _id: submissionId,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    if (!submission) {
        return next(new AppError("Submission not found.", 404));
    }

    // Step 2: Ownership check
    if (submission.student_id.toString() !== studentId.toString()) {
        return next(
            new AppError("Not authorized to submit this assessment.", 403),
        );
    }

    // Step 3: Status check
    if (submission.status !== "in_progress") {
        return next(new AppError("Submission already finalized.", 403));
    }

    // Step 4: Fetch assessment for timer check and auto-grading
    const assessment = await Assessment.findOne({
        _id: submission.assessment_id,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    }).select("+questions.options.isCorrect"); // Include answer keys for grading

    // Step 5: Timer expiry check
    if (assessment.timeLimitMinutes && submission.startedAt) {
        const deadline = new Date(
            submission.startedAt.getTime() +
                assessment.timeLimitMinutes * 60000,
        );
        const now = new Date();

        if (now > deadline) {
            // Timer expired: Force-submit with saved answers
            submission.status = "submitted";
            submission.submittedAt = now;

            await autoGradeSubmission(submission, assessment);
            await submission.save();

            return res.status(200).json({
                status: "success",
                data: { submission },
                autoSubmitted: true,
            });
        }
    }

    // Step 6: Normal submission flow
    submission.status = "submitted";
    submission.submittedAt = new Date();

    // Step 7: Auto-grade objective questions
    await autoGradeSubmission(submission, assessment);

    await submission.save();

    res.status(200).json({
        status: "success",
        data: { submission },
    });
});

/**
 * Auto-grade objective questions (MCQ-Single, MCQ-Multiple, TrueFalse)
 *
 * Helper function to grade auto-gradable question types
 * Modifies submission.answers in place and updates totalScore
 *
 * @private
 * @async
 * @param {Object} submission - Submission document
 * @param {Object} assessment - Assessment document with answer keys
 */
async function autoGradeSubmission(submission, assessment) {
    let totalScore = 0;

    submission.answers.forEach((answer) => {
        const question = assessment.questions.id(answer.questionId);

        if (!question) return;

        let score = 0;

        // Auto-grade based on question type
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
                    // Find all correct options
                    const correctOptionIds = question.options
                        .filter((opt) => opt.isCorrect)
                        .map((opt) => opt._id.toString());

                    const selectedIds = answer.selectedOptionIds.map((id) =>
                        id.toString(),
                    );

                    // Check if selected set matches correct set exactly
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
                    // Find the option that matches the selected answer
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

            // Short-Answer, Paragraph, FileUpload require manual grading
            default:
                score = 0;
        }

        answer.score = score;
        totalScore += score;
    });

    submission.totalScore = totalScore;

    // If all questions are auto-gradable, mark as graded
    const hasManualGradingQuestions = assessment.questions.some((q) =>
        ["Short-Answer", "Paragraph", "FileUpload"].includes(q.questionType),
    );

    if (!hasManualGradingQuestions) {
        submission.status = "graded";
    }
}

/**
 * Get a single submission (student or staff view)
 *
 * Business Logic:
 * 1. Fetch submission
 * 2. Permission check:
 *    - Students: Can only view their own submissions
 *    - Staff: Can view all submissions in their courses
 *
 * @route   GET /api/v1/submissions/:submissionId
 * @access  Students (owner), Doctors, TAs, College Admins
 *
 * @param   {Object} req.params.submissionId - Submission ID
 * @param   {Object} req.user - Authenticated user
 *
 * @returns {Object} 200 - { status: 'success', data: { submission } }
 * @throws  {AppError} 403 - Not authorized to view this submission
 * @throws  {AppError} 404 - Submission not found
 */
export const getSubmission = catchAsync(async (req, res, next) => {
    const { submissionId } = req.params;

    const submission = await Submission.findOne({
        _id: submissionId,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    })
        .populate("assessment_id", "title totalPoints")
        .populate("student_id", "name email")
        .populate("gradedBy_id", "name email");

    if (!submission) {
        return next(new AppError("Submission not found.", 404));
    }

    // Permission check
    if (req.user.role === "student") {
        if (submission.student_id._id.toString() !== req.user._id.toString()) {
            return next(
                new AppError("Not authorized to view this submission.", 403),
            );
        }
        // Hide scores if not allowed immediately and not fully graded
        if (
            !submission.assessment_id.settings.showGradesImmediately &&
            submission.status !== "graded"
        ) {
            submission.answers.forEach((a) => {
                a.score = undefined;
                a.feedback = undefined;
            });
            submission.totalScore = undefined;
        }
    }
    // Staff roles (doctor, ta, collegeAdmin) can view all submissions in their scope

    res.status(200).json({
        status: "success",
        data: { submission },
    });
});

/**
 * Get all submissions for an assessment (grading interface)
 *
 * Business Logic:
 * 1. Fetch assessment to verify staff has access
 * 2. Query all submissions for the assessment
 * 3. Optional status filter (submitted, graded)
 *
 * @route   GET /api/v1/submissions/assessment/:assessmentId
 * @access  Doctors, TAs, College Admins
 * @query   ?status=submitted (optional)
 *
 * @param   {Object} req.params.assessmentId - Assessment ID
 * @param   {Object} req.query.status - Optional status filter
 *
 * @returns {Object} 200 - { status: 'success', results: n, data: { submissions } }
 * @throws  {AppError} 404 - Assessment not found
 */
export const getSubmissionsByAssessment = catchAsync(async (req, res, next) => {
    const { assessmentId } = req.params;
    const { status } = req.query;

    // Verify assessment exists
    const assessment = await Assessment.findOne({
        _id: assessmentId,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    if (!assessment) {
        return next(new AppError("Assessment not found.", 404));
    }

    // Build query
    const filter = { assessment_id: assessmentId };
    if (status) {
        filter.status = status;
    }

    const submissions = await Submission.find(filter)
        .populate("student_id", "name email")
        .populate("gradedBy_id", "name email")
        .sort({ submittedAt: -1 });

    res.status(200).json({
        status: "success",
        results: submissions.length,
        data: { submissions },
    });
});

/**
 * Manually grade a submission
 *
 * Business Logic:
 * 1. Fetch submission and verify staff has access to course
 * 2. Update answer scores and feedback
 * 3. Recalculate totalScore
 * 4. Set status to 'graded', record gradedBy_id
 * 5. Trigger assignment grade recalculation for student
 *
 * @route   PATCH /api/v1/submissions/:submissionId/grade
 * @access  Doctors & TAs (assigned to course)
 * @body    { answers: [{ questionId, score, feedback? }] }
 *
 * @param   {Object} req.params.submissionId - Submission ID
 * @param   {Object} req.body.answers - Grading data
 * @param   {Object} req.user - Authenticated staff member
 *
 * @returns {Object} 200 - { status: 'success', data: { submission } }
 * @throws  {AppError} 404 - Submission not found
 *
 * @audit   D-23: Triggers recalculateAssignmentGrade to update enrollment
 */
export const gradeSubmission = catchAsync(async (req, res, next) => {
    const { submissionId } = req.params;
    const { answers } = req.body;

    // Step 1: Fetch submission
    const submission = await Submission.findOne({
        _id: submissionId,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    if (!submission) {
        return next(new AppError("Submission not found.", 404));
    }

    // Step 2: Fetch assessment to get question points
    const assessment = await Assessment.findOne({
        _id: submission.assessment_id,
        college_id: req.scopeFilter.college_id, // IDOR Guard
    });

    // Step 3: Update answer scores and feedback
    if (answers && answers.length > 0) {
        answers.forEach((gradingData) => {
            const answerIndex = submission.answers.findIndex(
                (a) =>
                    a.questionId.toString() ===
                    gradingData.questionId.toString(),
            );

            if (answerIndex >= 0) {
                submission.answers[answerIndex].score = gradingData.score || 0;
                if (gradingData.feedback) {
                    submission.answers[answerIndex].feedback =
                        gradingData.feedback;
                }
            }
        });
    }

    // Step 4: Recalculate totalScore
    submission.totalScore = submission.answers.reduce(
        (sum, answer) => sum + (answer.score || 0),
        0,
    );

    // Step 5: Check if fully graded (MED-2 fix)
    const allGraded = submission.answers.every(
        (a) =>
            a.score !== null &&
            a.score !== undefined &&
            a.feedback !== "Pending manual review",
    );

    if (allGraded) {
        submission.status = "graded";
        submission.gradedBy_id = req.user._id;
        await submission.save();

        // Step 6: Trigger assignment grade recalculation
        const assignmentGrade = await recalculateAssignmentGrade(
            submission.student_id,
            submission.courseOffering_id,
        );

        await Enrollment.findOneAndUpdate(
            {
                student_id: submission.student_id,
                course_id: submission.courseOffering_id,
            },
            { "grades.assignments": assignmentGrade },
        );
    } else {
        await submission.save();
    }

    res.status(200).json({
        status: "success",
        data: { submission },
    });
});
