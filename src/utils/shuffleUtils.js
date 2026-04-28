/**
 * ===================================================================================
 * @file      shuffleUtils.js
 * @desc      Deterministic shuffling utility using Linear Congruential Generator (LCG).
 *            Ensures same seed produces same shuffle order every time.
 * @module    utils/shuffleUtils
 * @audit     D-21: Seeded shuffle for consistent student experience
 * ===================================================================================
 */

/**
 * Shuffles an array deterministically using a seed value
 *
 * Uses Linear Congruential Generator (LCG) algorithm to produce
 * pseudo-random numbers from a seed. Same seed always produces
 * the same shuffle order, ensuring consistency across requests.
 *
 * Use Cases:
 * - Shuffle assessment questions per student (seed = studentId)
 * - Shuffle MCQ options per student (seed = studentId + questionId)
 * - Ensure student sees same order when returning to assessment
 *
 * Algorithm:
 * 1. Convert seed to numeric hash
 * 2. Create LCG random number generator with seed
 * 3. Fisher-Yates shuffle using seeded RNG
 *
 * @function seededShuffle
 * @param {Array} array - Array to shuffle (will NOT be mutated)
 * @param {string|number} seed - Seed value for deterministic randomization
 *
 * @returns {Array} New shuffled array (original array unchanged)
 *
 * @audit D-21 - Same seed → same order guarantee for student experience
 *
 * @note LCG parameters: a=1664525, c=1013904223, m=2^32 (Numerical Recipes)
 * @note Creates shallow copy - original array is not mutated
 *
 * @example
 * const questions = [q1, q2, q3, q4];
 * const studentId = '507f1f77bcf86cd799439011';
 *
 * const shuffled1 = seededShuffle(questions, studentId);
 * const shuffled2 = seededShuffle(questions, studentId);
 * // shuffled1 === shuffled2 (same order every time)
 *
 * @example
 * // Different seeds produce different orders
 * const order1 = seededShuffle([1,2,3,4,5], 'seed1'); // [3,1,5,2,4]
 * const order2 = seededShuffle([1,2,3,4,5], 'seed2'); // [2,5,1,4,3]
 * const order3 = seededShuffle([1,2,3,4,5], 'seed1'); // [3,1,5,2,4] (same as order1)
 */
export const seededShuffle = (array, seed) => {
    // Create shallow copy to avoid mutating original array
    const shuffled = [...array];

    // Convert seed to numeric hash
    let seedNum = 0;
    const seedStr = String(seed);
    for (let i = 0; i < seedStr.length; i++) {
        seedNum = (seedNum << 5) - seedNum + seedStr.charCodeAt(i);
        seedNum = seedNum & seedNum; // Convert to 32-bit integer
    }

    /**
     * Linear Congruential Generator (LCG) for pseudo-random numbers
     * Formula: X(n+1) = (a * X(n) + c) mod m
     *
     * Parameters from Numerical Recipes:
     * - a (multiplier) = 1664525
     * - c (increment) = 1013904223
     * - m (modulus) = 2^32
     *
     * @inner
     * @returns {number} Pseudo-random number between 0 and 1
     */
    const seededRandom = () => {
        seedNum = (seedNum * 1664525 + 1013904223) % Math.pow(2, 32);
        if (seedNum < 0) seedNum += Math.pow(2, 32);
        return seedNum / Math.pow(2, 32);
    };

    // Fisher-Yates shuffle algorithm with seeded RNG
    for (let i = shuffled.length - 1; i > 0; i--) {
        // Generate random index from 0 to i using seeded RNG
        const j = Math.floor(seededRandom() * (i + 1));

        // Swap elements at positions i and j
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
};
