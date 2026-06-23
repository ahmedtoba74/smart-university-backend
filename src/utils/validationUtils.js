/**
 * ===================================================================================
 * @file      validationUtils.js
 * @desc      Express validator checks and schemas for incoming payloads.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/Validation
 */

import { z } from "zod";

/**
 * Reusable Zod schema for validating MongoDB ObjectIds.
 * Enforces a 24-character hexadecimal string format.
 */
export const objectIdSchema = z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format. Must be a 24-character hexadecimal string.");
