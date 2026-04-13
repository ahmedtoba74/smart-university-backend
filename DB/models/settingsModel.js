import mongoose from "mongoose";

/**
 * @fileoverview Settings Model - Global system configuration singleton.
 * Manages academic calendar, enrollment periods, grading scales, credit limits,
 * and student progression thresholds. Enforces singleton pattern.
 *
 * @module models/Settings
 * @requires mongoose
 *
 * @description
 * Key Features:
 * - Singleton pattern (only one settings document exists)
 * - Academic calendar control (current year/semester)
 * - Enrollment period toggle
 * - Grade-to-GPA point mapping (gradePoints)
 * - Score-to-letter grade thresholds (gradeThresholds)
 * - Student level progression thresholds (levelThresholds)
 * - Per-status credit limits (defaultCreditLimit)
 * - Admin-configurable via PATCH /settings
 *
 * @audit
 * - GAP-5A: gradeThresholds Map for score-to-letter conversion (separate from gradePoints)
 * - GAP-5B: levelThresholds Map for earnedCredits-based level calculation
 */

/**
 * Settings Schema Definition
 *
 * @typedef {Object} Settings
 * @property {string} currentAcademicYear - Active academic year (e.g., "2025-2026")
 * @property {string} currentSemester - Active semester (First|Second|Summer)
 * @property {boolean} isEnrollmentOpen - Whether students can enroll in courses
 * @property {Map<string, number>} gradePoints - Letter grade to GPA points mapping (A+ → 4.0, etc.)
 * @property {Map<string, number>} gradeThresholds - Score percentage to letter grade mapping (A+ → 90, etc.)
 * @property {Map<number, number>} levelThresholds - Minimum earnedCredits per student level (1 → 0, 2 → 30, etc.)
 * @property {Object} defaultCreditLimit - Maximum credits per semester by academic status
 * @property {Date} createdAt - Auto-generated timestamp
 * @property {Date} updatedAt - Auto-generated timestamp
 */

const settingsSchema = new mongoose.Schema(
    {
        /**
         * Current academic year
         * Format: "YYYY-YYYY" (e.g., "2025-2026")
         * Controls which enrollments are considered "current"
         *
         * @type {string}
         * @required
         * @default "2025-2026"
         * @example "2025-2026"
         */
        currentAcademicYear: {
            type: String,
            required: true,
            default: "2025-2026",
        },

        /**
         * Current active semester
         * Determines which semester's courses are open for enrollment
         * Updated by admins at semester transitions
         *
         * @type {string}
         * @required
         * @enum ['First', 'Second', 'Summer']
         * @default 'First'
         */
        currentSemester: {
            type: String,
            required: true,
            enum: ["First", "Second", "Summer"],
            default: "First",
        },

        /**
         * Enrollment period toggle
         * Controls whether students can create new enrollments
         * Toggled by admins at enrollment window open/close
         *
         * @type {boolean}
         * @default false
         */
        isEnrollmentOpen: {
            type: Boolean,
            default: false,
        },

        /**
         * Letter grade to GPA points mapping
         * Used for cumulative GPA calculation
         * Each letter grade maps to a quality point value (0.0 - 4.0)
         *
         * Default Egyptian system scale:
         * A+ → 4.0, A → 3.7, B+ → 3.3, B → 3.0,
         * C+ → 2.7, C → 2.4, D+ → 2.2, D → 2.0, F → 0.0
         *
         * @type {Map<string, number>}
         * @default { 'A+': 4.0, 'A': 3.7, 'B+': 3.3, 'B': 3.0, 'C+': 2.7, 'C': 2.4, 'D+': 2.2, 'D': 2.0, 'F': 0.0 }
         *
         * @note Admin-configurable via PATCH /settings
         * @see GPA calculation formula: sum(gradePoints[letter] * creditHours) / sum(creditHours)
         */
        gradePoints: {
            type: Map,
            of: Number,
            default: {
                "A+": 4.0,
                A: 3.7,
                "B+": 3.3,
                B: 3.0,
                "C+": 2.7,
                C: 2.4,
                "D+": 2.2,
                D: 2.0,
                F: 0.0,
            },
        },

        /**
         * Score percentage to letter grade threshold mapping
         * Used to convert finalTotal (0-100) to letter grades
         * SEPARATE from gradePoints (which maps letters to GPA)
         *
         * Maps minimum score percentage required for each letter grade
         * Default thresholds (provisional, subject to university policy):
         * A+ → 90%, A → 85%, B+ → 80%, B → 75%,
         * C+ → 70%, C → 65%, D+ → 60%, D → 50%, F → 0%
         *
         * Letter assignment logic:
         * if (finalTotal >= 90) → 'A+'
         * else if (finalTotal >= 85) → 'A'
         * ... etc.
         *
         * @type {Map<string, number>}
         * @default { 'A+': 90, 'A': 85, 'B+': 80, 'B': 75, 'C+': 70, 'C': 65, 'D+': 60, 'D': 50, 'F': 0 }
         *
         * @audit GAP-5A/D-14 - Dynamic score-to-letter mapping (admin-configurable)
         * @note Admin-configurable via PATCH /settings
         * @see gradeUtils.mapScoreToLetter() for usage
         */
        gradeThresholds: {
            type: Map,
            of: Number,
            default: {
                "A+": 90,
                A: 85,
                "B+": 80,
                B: 75,
                "C+": 70,
                C: 65,
                "D+": 60,
                D: 50,
                F: 0,
            },
        },

        /**
         * Student level progression thresholds
         * Maps student level (1-5) to minimum earnedCredits required
         * Used to auto-calculate User.level based on User.earnedCredits
         *
         * Default thresholds (provisional, subject to university policy):
         * Level 1 → 0 credits   (freshman)
         * Level 2 → 30 credits  (sophomore)
         * Level 3 → 60 credits  (junior)
         * Level 4 → 90 credits  (senior)
         * Level 5 → 120 credits (super senior / extended program)
         *
         * Level calculation logic:
         * if (earnedCredits >= 120) → level 5
         * else if (earnedCredits >= 90) → level 4
         * ... etc.
         *
         * @type {Map<number, number>}
         * @default { 1: 0, 2: 30, 3: 60, 4: 90, 5: 120 }
         *
         * @audit GAP-5B/D-13 - Dynamic level thresholds (admin-configurable)
         * @note Admin-configurable via PATCH /settings
         * @note Used in gradebook publish workflow to update User.level
         */
        levelThresholds: {
            type: Map,
            of: Number,
            default: {
                1: 0, // Freshman: 0-29 credits
                2: 30, // Sophomore: 30-59 credits
                3: 60, // Junior: 60-89 credits
                4: 90, // Senior: 90-119 credits
                5: 120, // Super Senior: 120+ credits
            },
        },

        /**
         * Maximum credit hours per semester by academic status
         * Enforced during enrollment (Gate 2: Credit Limit)
         *
         * good_standing: Students with GPA >= 2.0
         * probation: Students with GPA < 2.0 (restricted enrollment)
         * honors: High-performing students (GPA >= 3.5, can take extra load)
         *
         * @type {Object}
         * @property {number} good_standing - Max credits for regular students (default: 18)
         * @property {number} probation - Max credits for probation students (default: 12)
         * @property {number} honors - Max credits for honors students (default: 21)
         *
         * @note Admin-configurable via PATCH /settings
         * @see Phase 3 enrollment gates for usage
         */
        defaultCreditLimit: {
            good_standing: {
                type: Number,
                default: 18,
            },
            probation: {
                type: Number,
                default: 12,
            },
            honors: {
                type: Number,
                default: 21,
            },
        },
    },
    {
        timestamps: true,
    },
);

// ===========================================
// STATIC METHODS
// ===========================================

/**
 * Singleton pattern enforcement - Get or create the single Settings document
 *
 * Ensures only one Settings document exists in the database
 * If no settings exist, creates one with default values
 *
 * @static
 * @async
 * @returns {Promise<Settings>} The singleton Settings document
 *
 * @example
 * const settings = await Settings.getSettings();
 * console.log(settings.currentAcademicYear); // "2025-2026"
 */
settingsSchema.statics.getSettings = async function () {
    const settings = await this.findOne();
    if (settings) return settings;
    return await this.create({});
};

// ===========================================
// MODEL EXPORT
// ===========================================

/**
 * Settings Model (Singleton)
 * @type {mongoose.Model<Settings>}
 */
const Settings = mongoose.model("Settings", settingsSchema);
export default Settings;
