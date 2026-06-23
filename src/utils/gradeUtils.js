/**
 * ===================================================================================
 * @file      gradeUtils.js
 * @desc      Grade calculation utilities for LMS & Gradebook system.
 *            Provides score-to-letter mapping and assignment grade aggregation.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    utils/gradeUtils
 */

import Submission from "../../DB/models/submissionModel.js";
import Enrollment from "../../DB/models/enrollmentModel.js";
import mongoose from "mongoose";

// Dynamically retrieve the model to prevent circular dependency issues
const CourseOffering = mongoose.model("CourseOffering");

/**
 * Maps a numeric score to a letter grade using dynamic thresholds
 *
 * Converts finalTotal (0-100 scale) to letter grade (A+, A, B+, ..., F)
 * using the thresholds defined in Settings.gradeThresholds
 *
 * Algorithm:
 * 1. Calculate percentage: (finalTotal / totalDegree) * 100
 * 2. Find highest threshold the percentage meets or exceeds
 * 3. Return corresponding letter grade
 *
 * @function mapScoreToLetter
 * @param {number} finalTotal - Student's weighted final score (0-totalDegree scale)
 * @param {number} totalDegree - Course's total possible points (e.g., 100, 150)
 * @param {Map<string, number>} gradeThresholds - Score percentage thresholds from Settings
 * Example: Map { 'A+' => 90, 'A' => 85, 'B+' => 80, ..., 'F' => 0 }
 *
 * @returns {string} Letter grade (A+, A, B+, B, C+, C, D+, D, F)
 *
 * @audit LOW-1 - Defense against division by zero
 * @note Thresholds MUST be in descending order for correct mapping
 *
 * @example
 * // With default thresholds: { 'A+': 90, 'A': 85, 'B+': 80, ... }
 * mapScoreToLetter(92, 100, gradeThresholds) // Returns 'A+'
 * mapScoreToLetter(87, 100, gradeThresholds) // Returns 'A'
 * mapScoreToLetter(45, 100, gradeThresholds) // Returns 'F'
 */
export const mapScoreToLetter = (finalTotal, totalDegree, gradeThresholds) => {
    // Guard: Prevent division by zero (audit finding LOW-1)
    // If totalDegree is invalid, default to 'F' rather than crashing
    if (totalDegree <= 0) {
        console.error(
            `[mapScoreToLetter] Invalid totalDegree: ${totalDegree}. Defaulting to 'F'.`,
        );
        return "F";
    }

    // Calculate percentage score (0-100 scale)
    const percentage = (finalTotal / totalDegree) * 100;

    // Convert Map to array and sort by threshold descending
    const thresholdEntries = Array.from(gradeThresholds.entries()).sort(
        (a, b) => b[1] - a[1],
    );

    // Find first threshold the percentage meets or exceeds
    for (const [letter, threshold] of thresholdEntries) {
        if (percentage >= threshold) {
            return letter;
        }
    }

    // Fallback: If percentage is below all thresholds, return 'F'
    return "F";
};

/**
 * Recalculates a student's assignment grade component for a course offering
 *
 * Aggregates all graded submissions for the student in the given course,
 * calculates total earned points, and applies the assignment max ceiling.
 * Uses the accumulator pattern to allow flexible extra-credit and point-based
 * grading without enforcing percentage ratios.
 *
 * Algorithm:
 * 1. Get assignment grade ceiling from course offering's gradingPolicy
 * 2. Find all graded submissions for student in course offering
 * 3. Sum totalScore from each submission (earned points)
 * 4. Apply ceiling cap: Math.min(rawScore, assignmentMax)
 *
 * @async
 * @function recalculateAssignmentGrade
 * @param {ObjectId|string} studentId - Student's user ID
 * @param {ObjectId|string} offeringId - Course offering ID
 *
 * @returns {Promise<number>} Assignment grade capped at gradingPolicy.assignments
 *
 * @audit MED-1 - Uses compound index { student_id, courseOffering_id, status }
 * @audit D-8 - Uses Accumulator pattern, NO percentage ratios.
 * @audit D-23 - Self-healing race window: If two TAs grade concurrently,
 * next recalc will include both submissions automatically
 *
 * @example
 * const assignmentGrade = await recalculateAssignmentGrade(studentId, offeringId);
 * enrollment.grades.assignments = assignmentGrade;
 * await enrollment.save();
 */
export const recalculateAssignmentGrade = async (studentId, offeringId) => {
    // 1. Get assignment grade ceiling from offering
    const offering =
        await CourseOffering.findById(offeringId).select("gradingPolicy");
    const assignmentMax = offering?.gradingPolicy?.assignments || 0;

    // 2. Aggregate totalScore of ALL 'graded' submissions
    const result = await Submission.aggregate([
        {
            // Stage 1: Filter graded submissions for this student in this course
            // Uses compound index { student_id: 1, courseOffering_id: 1, status: 1 }
            // This is a covered query - no document fetch needed (MED-1)
            $match: {
                student_id: new mongoose.Types.ObjectId(studentId),
                courseOffering_id: new mongoose.Types.ObjectId(offeringId),
                status: "graded",
            },
        },
        {
            // Stage 2: Group by student and sum earned points
            $group: {
                _id: null,
                rawScore: { $sum: "$totalScore" },
            },
        },
    ]);

    const rawScore = result[0]?.rawScore ?? 0;

    // 3. Apply ceiling cap (Math.min) - No percentage ratios (Decision D-8)
    const assignmentGrade = Math.min(rawScore, assignmentMax);

    // 4. Write directly to enrollment (Plan Section 15, CRIT-5)
    await Enrollment.findOneAndUpdate(
        { student_id: studentId, course_id: offeringId, status: "enrolled" },
        { $set: { "grades.assignments": assignmentGrade } },
    );

    return assignmentGrade;
};
