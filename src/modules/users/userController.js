import User from "../../../DB/models/userModel.js";
import BulkImportLog from "../../../DB/models/bulkImportLogModel.js";
import Department from "../../../DB/models/departmentModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import APIFeatures from "../../utils/apiFeatures.js";
import { uploadToCloudinary } from "../../utils/uploadHelper.js";
import {
    encrypt,
    hashForSearch,
    encryptBulkPassword,
    decryptBulkPassword,
} from "../../utils/cryptoUtils.js";
import { generateTempPassword } from "../../utils/generateTempPassword.js";
import Email from "../../services/email.js";
import xlsx from "xlsx";

const MAX_BULK_IDS = 500;
const MAX_ROWS = 1000;

const ALLOWED_ROLES = [
    "student",
    "ta",
    "doctor",
    "collegeAdmin",
    "universityAdmin",
];
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const NATIONAL_ID_REGEX = /^[0-9]{14}$/;
const PHONE_REGEX = /^01[0125][0-9]{8}$/;

/**
 * Create a new user.
 * @async
 * @function createUser
 * @param {Object} req - Express request object.
 * @param {Object} req.body - The request body containing user details.
 * @param {string} req.body.name - User's name.
 * @param {string} req.body.email - User's email.
 * @param {string} req.body.nationalID - User's national ID.
 * @param {string} req.body.role - User's role.
 * @param {string} req.body.phoneNumber - User's phone number.
 * @param {string} [req.body.college_id] - User's college ID (req for universityAdmin).
 * @param {string} [req.body.department_id] - User's department ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the created user.
 */

export const createUser = catchAsync(async (req, res, next) => {
    const { name, email, nationalID, phoneNumber, role, department_id } =
        req.body;

    // 1. Strict Validation
    if (!name || !email || !nationalID || !phoneNumber || !role) {
        return next(
            new AppError(
                "Please provide all required fields: name, email, nationalID, phoneNumber, role",
                400,
            ),
        );
    }

    if (req.body.password || req.body.passwordConfirm) {
        return next(
            new AppError(
                "Password cannot be provided manually. It is auto-generated.",
                400,
            ),
        );
    }

    const nationalIDRegex = /^[0-9]{14}$/;
    if (!nationalIDRegex.test(nationalID)) {
        return next(new AppError("Invalid national ID format.", 400));
    }

    const phoneRegex = /^01[0125][0-9]{8}$/;
    if (!phoneRegex.test(phoneNumber)) {
        return next(new AppError("Invalid phone number format.", 400));
    }

    const allowedRoles = [
        "student",
        "ta",
        "doctor",
        "collegeAdmin",
        "universityAdmin",
    ];
    if (!allowedRoles.includes(role)) {
        return next(new AppError("Invalid role provided.", 400));
    }

    // 2. College ID Assignment Logic
    let college_id;
    if (req.user.role === "collegeAdmin") {
        college_id = req.user.college_id; // Always override
    } else if (req.user.role === "universityAdmin") {
        if (!req.body.college_id) {
            return next(
                new AppError(
                    "universityAdmin must explicitly provide a college_id to create a user.",
                    400,
                ),
            );
        }
        college_id = req.body.college_id;
    }

    // 3. Photo Upload
    let photoUrl = "default_profile.jpg";
    if (req.files && req.files.photo) {
        const photoFile = req.files.photo[0];
        try {
            const result = await uploadToCloudinary(
                photoFile.buffer,
                "users/profiles",
            );
            photoUrl = result.secure_url;
        } catch (error) {
            return next(new AppError("Failed to upload photo", 500));
        }
    }

    // 4. Compile and Save User Document
    const tempPass = generateTempPassword();

    const user = new User({
        name,
        email,
        nationalID,
        phoneNumber,
        role,
        department_id: department_id || undefined,
        college_id,
        photo: photoUrl,
        password: tempPass,
        requiresPasswordChange: true,
        credentialEmailSent: false,
    });

    await user.save(); // Triggers blind indexing and password hashing

    // 5. Asynchronous Email Sending (Do not fail creation if email fails)
    try {
        await new Email(user, "").sendCredentials(tempPass);
        user.credentialEmailSent = true;
        await user.save({ validateBeforeSave: false });
    } catch (err) {
        console.error(
            `❌ Failed to send welcome credentials email for user ${user._id}:`,
            err,
        );
    }

    // 6. Respond Success
    user.password = undefined;
    res.status(201).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Get all users.
 * @async
 * @function getAllUsers
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the list of users.
 */
export const getAllUsers = catchAsync(async (req, res, next) => {
    let archivedFilter = {};
    let skipActiveCheck = false;

    if (req.query.isArchived === "true") {
        archivedFilter = { active: false };
        skipActiveCheck = true;
    } else if (req.query.isArchived === "false") {
        archivedFilter = { active: true };
    } else if (req.query.isArchived === "all") {
        archivedFilter = {};
        skipActiveCheck = true;
    }

    const queryObj = { ...req.query };
    delete queryObj.isArchived;

    let baseQuery = User.find({ ...req.scopeFilter, ...archivedFilter });
    if (skipActiveCheck) {
        baseQuery = baseQuery.setOptions({ skipActiveCheck: true });
    }

    const features = new APIFeatures(baseQuery, queryObj)
        .filter()
        .sort()
        .limitFields()
        .paginate();

    const users = await features.query;

    const mergedFilter = {
        ...req.scopeFilter,
        ...archivedFilter,
        ...features._filterObj,
    };

    const totalResults = await User.countDocuments(mergedFilter).setOptions({
        skipActiveCheck: skipActiveCheck,
    });

    res.status(200).json({
        status: "success",
        results: users.length,
        currentPage: features.page,
        totalPages: Math.ceil(totalResults / features.limit) || 1,
        totalResults,
        data: {
            users,
        },
    });
});

/**
 * Get a specific user by ID.
 * @async
 * @function getUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the user details.
 */
export const getUser = catchAsync(async (req, res, next) => {
    // 1. Find user with scope filter and skipActiveCheck (so admins can see inactive users)
    const user = await User.findOne({ _id: req.params.id, ...req.scopeFilter })
        .select("+nationalID +credentialEmailSent")
        .populate("department_id", "name")
        .populate("college_id", "name")
        .setOptions({ skipActiveCheck: true });

    // 2. Not found
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 3. Safety: ensure password is not leaked (though it's hidden by default, it's good practice)
    user.password = undefined;

    // 4. Response (realNationalID virtual auto-decrypts)
    res.status(200).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Update a user by ID.
 * @async
 * @function updateUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} req.body - Fields to update.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the updated user.
 */
export const updateUser = catchAsync(async (req, res, next) => {
    // 1. Find User with Scope Filter
    const user = await User.findOne({ _id: req.params.id, ...req.scopeFilter });
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 2. Strip Forbidden Fields
    const FORBIDDEN_FIELDS = [
        "password",
        "passwordConfirm",
        "gpa",
        "earnedCredits",
        "level",
        "active",
        "requiresPasswordChange",
        "tokensInvalidatedAt",
        "college_id",
        "nationalID",
        "nationalIDHash",
        "credentialEmailSent",
        "loginAttempts",
        "lockUntil",
        "lockoutStage",
        "twoFactorSecret",
        "twoFactorExpires",
        "passwordResetToken",
        "passwordResetExpires",
        "passwordChangedAt",
        "lastLoginAt",
        "role",
    ];

    const filteredBody = { ...req.body };
    FORBIDDEN_FIELDS.forEach((field) => delete filteredBody[field]);

    // 3. Photo Upload
    if (req.files && req.files.photo) {
        const photoFile = req.files.photo[0];
        try {
            const result = await uploadToCloudinary(
                photoFile.buffer,
                "users/profiles",
            );
            user.photo = result.secure_url;
        } catch (error) {
            return next(new AppError("Failed to upload photo", 500));
        }
    }

    // 4. Validate Department ID
    if (filteredBody.department_id) {
        const departmentExists = await Department.findOne({
            _id: filteredBody.department_id,
            college_id: user.college_id,
        });

        if (!departmentExists) {
            return next(
                new AppError(
                    "Department does not belong to this user's college",
                    400,
                ),
            );
        }
    }

    // 5. Apply Allowed Fields
    Object.keys(filteredBody).forEach((key) => {
        user[key] = filteredBody[key];
    });

    // 6. Save User (Triggers Hooks)
    await user.save();

    // 7. Prevent Password Leak
    user.password = undefined;

    // 8. Response
    res.status(200).json({
        status: "success",
        data: { user },
    });
});

/**
 * Deactivate a user (soft delete).
 * @async
 * @function deactivateUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 204 No Content response.
 */
export const deactivateUser = catchAsync(async (req, res, next) => {
    // 1. Prevent self-deactivation
    if (req.params.id === req.user._id.toString()) {
        return next(
            new AppError("You cannot deactivate your own account.", 400),
        );
    }

    // 2. Find User with scope and allow finding already inactive users
    const user = await User.findOne({
        _id: req.params.id,
        ...req.scopeFilter,
    }).setOptions({
        skipActiveCheck: true,
    });

    // 3. Not found
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 4. Already deactivated
    if (user.active === false) {
        return next(new AppError("User is already deactivated", 400));
    }

    // 5. Deactivate & Save
    user.active = false;
    await user.save({ validateBeforeSave: false });

    // 6. Response
    res.status(204).send();
});

/**
 * Middleware to set the user ID in params to the current user's ID.
 * Useful for endpoints that require the ID in params but the user is logged in.
 * @function getMe
 * @param {Object} req - Express request object.
 * @param {Object} req.user - The authenticated user object.
 * @param {string} req.user.id - The authenticated user's ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 */
export const getMe = (req, res, next) => {
    req.params.id = req.user.id;
    return next();
};

/**
 * Lookup a user by National ID.
 * @async
 * @function lookupUserByNationalID
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.nationalID - User's national ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the user details.
 */
export const lookupUserByNationalID = catchAsync(async (req, res, next) => {
    const { nationalID } = req.body;
    if (!nationalID) {
        return next(new AppError("National ID is required", 400));
    }

    const hashedID = hashForSearch(nationalID);
    const user = await User.findOne({
        nationalIDHash: hashedID,
        ...req.scopeFilter,
    })
        .select("+nationalID +credentialEmailSent")
        .populate("department_id", "name")
        .populate("college_id", "name")
        .setOptions({ skipActiveCheck: true });

    if (!user) {
        return next(new AppError("No user found with this National ID.", 404));
    }

    user.password = undefined;

    res.status(200).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Restore a deactivated user (admin only).
 * @async
 * @function restoreUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 204 No Content response.
 */
export const restoreUser = catchAsync(async (req, res, next) => {
    // 1. Find User (No scopeFilter needed as this is universityAdmin only)
    const user = await User.findOne({ _id: req.params.id }).setOptions({
        skipActiveCheck: true,
    });

    // 2. Not found
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 3. Already active
    if (user.active === true) {
        return next(new AppError("User is already active", 400));
    }

    // 4. Restore & Save
    user.active = true;
    await user.save({ validateBeforeSave: false });

    // 5. Response
    res.status(200).json({
        status: "success",
        message: "User restored successfully",
        data: {
            user,
        },
    });
});

/**
 * Unlock a locked user account (admin only).
 * @async
 * @function unlockUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 204 No Content response.
 */
export const unlockUser = catchAsync(async (req, res, next) => {
    // 1. Find User (universityAdmin only, no scopeFilter)
    const user = await User.findOne({ _id: req.params.id });
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 2. Validation
    if (user.loginAttempts === 0 && !user.lockUntil) {
        return next(new AppError("User account is not locked", 400));
    }

    // 3. Action
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    user.lockoutStage = 0;
    await user.save({ validateBeforeSave: false });

    // 4. Response
    res.status(204).send();
});

/**
 * Force logout a user by invalidating their tokens (admin only).
 * @async
 * @function forceLogoutUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 204 No Content response.
 */
export const forceLogoutUser = catchAsync(async (req, res, next) => {
    // 1. Prevent self force-logout
    if (req.params.id === req.user._id.toString()) {
        return next(
            new AppError("You cannot force logout your own account.", 400),
        );
    }

    // 2. Find User (universityAdmin only)
    const user = await User.findOne({ _id: req.params.id });
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 3. Action
    user.tokensInvalidatedAt = new Date();
    await user.save({ validateBeforeSave: false });

    // 4. Response
    res.status(204).send();
});

/**
 * Reset a user's password (admin only).
 * @async
 * @function resetUserPassword
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 200 OK response.
 */

export const resetUserPassword = catchAsync(async (req, res, next) => {
    // 1. Find User (universityAdmin only, no scopeFilter)
    const user = await User.findOne({ _id: req.params.id, ...req.scopeFilter });
    if (!user) return next(new AppError("User not found", 404));

    const tempPass = generateTempPassword();

    user.password = tempPass;
    user.requiresPasswordChange = true;
    user.tokensInvalidatedAt = new Date();
    user.credentialEmailSent = false;

    await user.save(); // pre-save hashes password

    try {
        await new Email(user, "").sendCredentials(tempPass);
        user.credentialEmailSent = true;
        await user.save({ validateBeforeSave: false });
    } catch (err) {
        console.error(
            `Failed to send reset password email for user ${user._id}:`,
            err,
        );
    }

    res.status(200).json({
        status: "success",
        message: "Temporary password sent to user email.",
    });
});

/**
 * Change a user's role (universityAdmin only).
 * @async
 * @function changeUserRole
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.role - New role.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the updated user.
 */
export const changeUserRole = catchAsync(async (req, res, next) => {
    const { role } = req.body;
    const allowedRoles = [
        "student",
        "ta",
        "doctor",
        "collegeAdmin",
        "universityAdmin",
    ];

    // 1. Validate role enum
    if (!allowedRoles.includes(role)) {
        return next(new AppError("Invalid role provided.", 400));
    }

    // 2. Prevent changing own role
    if (req.params.id === req.user._id.toString()) {
        return next(new AppError("You cannot change your own role.", 400));
    }

    // 3. Find User (universityAdmin only, no scopeFilter)
    const user = await User.findOne({ _id: req.params.id });
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 4. Update & Save
    user.role = role;
    await user.save({ validateBeforeSave: false });

    // 5. Response
    user.password = undefined;
    res.status(200).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Assign an RFID tag to a user (universityAdmin only).
 * @async
 * @function assignRfid
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.rfid - RFID tag value.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the assigned RFID.
 */
export const assignRfid = catchAsync(async (req, res, next) => {
    const rfidTag = req.body.rfidTag?.trim();

    if (!rfidTag) {
        return next(new AppError("rfidTag is required", 400));
    }

    // 1. Find User
    const user = await User.findOne({ _id: req.params.id, ...req.scopeFilter });

    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 2. Check if RFID is already assigned to a DIFFERENT user
    const existingUserWithRfid = await User.findOne({ rfidTag }).setOptions({
        skipActiveCheck: true,
    });

    if (
        existingUserWithRfid &&
        existingUserWithRfid._id.toString() !== user._id.toString()
    ) {
        return next(
            new AppError("RFID tag is already assigned to another user", 400),
        );
    }

    // 3. Update & Save
    user.rfidTag = rfidTag;
    await user.save({ validateBeforeSave: false });

    // 4. Response
    res.status(200).json({
        status: "success",
        data: {
            rfidTag: user.rfidTag,
        },
    });
});

/**
 * Graduate a user, changing their role from student to alumni.
 * @async
 * @function graduateUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the updated user.
 */
export const graduateUser = catchAsync(async (req, res, next) => {
    // 1. Find User (Applies scopeFilter so collegeAdmin can only graduate from their college)
    const user = await User.findOne({ _id: req.params.id, ...req.scopeFilter });

    if (!user) {
        return next(new AppError("User not found", 404));
    }

    // 2. Validate Current Role
    if (user.role !== "student") {
        return next(
            new AppError("Only active students can be graduated.", 400),
        );
    }

    if (user.academicStatus === "graduated") {
        return next(new AppError("User is already graduated.", 400));
    }

    // 3. Update Role & Save
    user.academicStatus = "graduated";
    await user.save({ validateBeforeSave: false });

    // 4. Response
    user.password = undefined;
    res.status(200).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Allocate multiple users to a department.
 * @async
 * @function allocateUsers
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string[]} req.body.userIds - Array of user IDs.
 * @param {string} req.body.department_id - Department ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the update result.
 */
export const allocateUsers = catchAsync(async (req, res, next) => {
    const { studentIds, targetDepartmentId } = req.body;

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        return next(
            new AppError(
                "Please provide a non-empty array of studentIds.",
                400,
            ),
        );
    }

    if (!targetDepartmentId) {
        return next(new AppError("Please provide a targetDepartmentId.", 400));
    }

    if (studentIds.length > MAX_BULK_IDS) {
        return next(
            new AppError(
                `Cannot allocate more than ${MAX_BULK_IDS} users at once.`,
                400,
            ),
        );
    }

    // 1. Verify destination department exists and matches college scope (if applicable)
    const departmentQuery = { _id: targetDepartmentId };
    if (req.user.role === "collegeAdmin") {
        departmentQuery.college_id = req.user.college_id;
    }

    const department = await Department.findOne(departmentQuery);
    if (!department) {
        return next(
            new AppError(
                "Department not found or does not belong to your college.",
                404,
            ),
        );
    }

    // 2. Perform bulk update
    // Update users matching the given IDs AND belonging to the SAME college as the department.
    // Also apply req.scopeFilter (which limits to req.user.college_id for collegeAdmins).
    const result = await User.updateMany(
        {
            _id: { $in: studentIds },
            college_id: department.college_id,
            ...req.scopeFilter,
        },
        { $set: { department_id: department._id } },
        { runValidators: true },
    );

    res.status(200).json({
        status: "success",
        message: `${result.modifiedCount} users allocated successfully out of ${studentIds.length} requested.`,
        data: {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
        },
    });
});

/**
 * Perform a bulk action on multiple users (deactivate, activate, move-department, graduate).
 * @async
 * @function bulkActions
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string[]} req.body.userIds - Array of user IDs.
 * @param {string} req.body.action - Action to perform ('deactivate', 'activate', 'move-department', or 'graduate').
 * @param {Object} [req.body.payload] - Additional payload for specific actions.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a 204 No Content response.
 */
export const bulkActions = catchAsync(async (req, res, next) => {
    const { action, userIds, payload } = req.body;

    if (!action || !Array.isArray(userIds) || userIds.length === 0) {
        return next(
            new AppError("action and userIds array are required.", 400),
        );
    }

    // 1. Deduplication
    const uniqueIds = [...new Set(userIds.map(String))];

    if (uniqueIds.length > MAX_BULK_IDS) {
        return next(
            new AppError(
                `Cannot process more than ${MAX_BULK_IDS} users at once.`,
                400,
            ),
        );
    }

    // 2. Self-inclusion guard
    if (uniqueIds.includes(req.user._id.toString())) {
        return next(
            new AppError(
                "You cannot include your own account in a bulk action.",
                400,
            ),
        );
    }

    const scopedFilter = { _id: { $in: uniqueIds }, ...req.scopeFilter };
    const SUPPORTED_ACTIONS = [
        "deactivate",
        "activate",
        "move-department",
        "graduate",
    ];

    if (!SUPPORTED_ACTIONS.includes(action)) {
        return next(
            new AppError(
                `Unsupported action: "${action}". Supported: ${SUPPORTED_ACTIONS.join(", ")}.`,
                400,
            ),
        );
    }

    let result;

    // ── deactivate ───────────────────────────────────────────────
    if (action === "deactivate") {
        result = await User.updateMany(scopedFilter, {
            $set: { active: false },
        }).setOptions({ skipActiveCheck: true });

        // ── activate ─────────────────────────────────────────────────
    } else if (action === "activate") {
        result = await User.updateMany(scopedFilter, {
            $set: { active: true },
        }).setOptions({ skipActiveCheck: true });

        // ── move-department ──────────────────────────────────────────
    } else if (action === "move-department") {
        if (!payload?.departmentId) {
            return next(
                new AppError(
                    "payload.departmentId is required for move-department action.",
                    400,
                ),
            );
        }

        const department = await Department.findOne({
            _id: payload.departmentId,
            college_id: req.user.college_id,
        });
        if (!department) {
            return next(
                new AppError("Department not found within your college.", 404),
            );
        }

        result = await User.updateMany(scopedFilter, {
            $set: { department_id: payload.departmentId },
        });

        // ── graduate ─────────────────────────────────────────────────
    } else if (action === "graduate") {
        // Only students can be graduated
        result = await User.updateMany(
            {
                ...scopedFilter,
                role: "student",
                academicStatus: { $ne: "graduated" },
            },
            { $set: { academicStatus: "graduated" } },
        );

        // Count already-graduated separately for accurate reporting
        const alreadyGraduated = await User.countDocuments({
            ...scopedFilter,
            role: "student",
            academicStatus: "graduated",
        });

        const nonStudents = await User.countDocuments({
            _id: { $in: uniqueIds },
            ...req.scopeFilter,
            role: { $ne: "student" },
        });

        return res.status(200).json({
            status: "success",
            data: {
                action,
                requested: uniqueIds.length,
                modified: result.modifiedCount,
                alreadyGraduated,
                skippedNonStudents: nonStudents,
                notFound:
                    uniqueIds.length -
                    result.matchedCount -
                    alreadyGraduated -
                    nonStudents,
            },
        });
    }

    // ── Generic response for deactivate / activate / move-department ──
    res.status(200).json({
        status: "success",
        data: {
            action,
            requested: uniqueIds.length,
            modified: result.modifiedCount,
            matched: result.matchedCount,
            notModified: result.matchedCount - result.modifiedCount,
            notFound: uniqueIds.length - result.matchedCount,
        },
    });
});

/**
 * Bulk import users from an Excel or CSV file.
 * @async
 * @function bulkImportUsers
 * @param {Object} req - Express request object.
 * @param {Object} req.file - The uploaded Excel/CSV file holding user data.
 * @param {Object} req.body - Additional parameters.
 * @param {string} [req.body.college_id] - Target college ID (Required for universityAdmin).
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON report of the import process.
 */
export const bulkImportUsers = catchAsync(async (req, res, next) => {
    // 1. File check
    if (!req.file) {
        return next(new AppError("Please upload an Excel or CSV file.", 400));
    }

    // 2. college_id resolution
    const isCollegeAdmin = req.user.role === "collegeAdmin";
    const targetCollegeId = isCollegeAdmin
        ? req.user.college_id
        : req.body.college_id;

    if (!isCollegeAdmin && !targetCollegeId) {
        return next(
            new AppError("college_id is required for universityAdmin.", 400),
        );
    }

    // 3. Parse Excel
    let workbook;
    try {
        workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    } catch {
        return next(
            new AppError(
                "Failed to parse file. Ensure it is a valid Excel or CSV file.",
                400,
            ),
        );
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows || rows.length === 0) {
        return next(new AppError("The uploaded file is empty.", 400));
    }
    if (rows.length > MAX_ROWS) {
        return next(
            new AppError(
                `Cannot import more than ${MAX_ROWS} rows at once.`,
                400,
            ),
        );
    }

    // 4. Per-row validation — collect valid docs and failed records
    const validDocs = [];
    const failedRecords = [];

    // Make sure we have a secret for the bulk log
    const HASH_SECRET = process.env.HASH_SECRET;
    if (!HASH_SECRET) {
        return next(
            new AppError(
                "Server configuration error: HASH_SECRET is missing.",
                500,
            ),
        );
    }

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +1 for 0-index, +1 for header

        const { name, email, nationalID, phoneNumber, role, department_id } =
            row;
        const natIdStr = String(nationalID || "").trim();
        const phoneStr = String(phoneNumber || "").trim();
        const emailStr = String(email || "")
            .trim()
            .toLowerCase();

        // Required fields
        if (!name || !emailStr || !natIdStr || !role) {
            failedRecords.push({
                row: rowNum,
                name: name || "Unknown",
                email: emailStr || "Unknown",
                nationalID: natIdStr || "Unknown",
                status: "failed",
                failReason: "Missing required fields.",
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }
        if (!EMAIL_REGEX.test(emailStr)) {
            failedRecords.push({
                row: rowNum,
                name,
                email: emailStr,
                nationalID: natIdStr,
                status: "failed",
                failReason: "Invalid email format.",
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }
        if (!NATIONAL_ID_REGEX.test(natIdStr)) {
            failedRecords.push({
                row: rowNum,
                name,
                email: emailStr,
                nationalID: natIdStr,
                status: "failed",
                failReason: "Invalid national ID format.",
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }
        if (phoneStr && !PHONE_REGEX.test(phoneStr)) {
            failedRecords.push({
                row: rowNum,
                name,
                email: emailStr,
                nationalID: natIdStr,
                status: "failed",
                failReason: "Invalid phone number format.",
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }
        if (!ALLOWED_ROLES.includes(role)) {
            failedRecords.push({
                row: rowNum,
                name,
                email: emailStr,
                nationalID: natIdStr,
                status: "failed",
                failReason: `Invalid role. Allowed: ${ALLOWED_ROLES.join(", ")}.`,
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }

        // Per-row college_id (universityAdmin can specify per row or fallback to body)
        const rowCollegeId = isCollegeAdmin
            ? targetCollegeId
            : row.college_id || targetCollegeId;

        if (!rowCollegeId) {
            failedRecords.push({
                row: rowNum,
                name,
                email: emailStr,
                nationalID: natIdStr,
                status: "failed",
                failReason: "college_id missing for this row.",
                userId: null,
                tempPassword: null,
                emailSent: false,
            });
            continue;
        }

        // 5. Build User document — plain nationalID → pre-save hook handles everything
        const tempPass = generateTempPassword();
        const userDoc = new User({
            name: String(name).trim(),
            email: emailStr,
            nationalID: natIdStr, // ← plain, pre-save hook encrypts + hashes
            phoneNumber: phoneStr || undefined,
            role,
            college_id: rowCollegeId,
            department_id: department_id || undefined,
            password: tempPass, // ← plain, pre-save hook hashes via bcrypt
            requiresPasswordChange: true,
            credentialEmailSent: false,
        });

        validDocs.push({
            user: userDoc,
            plainTempPass: tempPass,
            rowNum,
            name: String(name).trim(),
            email: emailStr,
            nationalID: natIdStr,
        });
    }

    // Early exit if nothing valid
    if (validDocs.length === 0) {
        const log = await BulkImportLog.create({
            importedBy: req.user._id,
            college_id: targetCollegeId,
            totalRows: rows.length,
            created: 0,
            failed: failedRecords.length,
            records: failedRecords,
        });
        return res.status(200).json({
            status: "success",
            data: {
                created: 0,
                failed: failedRecords.length,
                log: { id: log._id },
            },
        });
    }

    // 6. Save in parallel — pre-save hooks MUST fire (bcrypt + blind indexing)
    const saveResults = await Promise.allSettled(
        validDocs.map((d) => d.user.save()),
    );

    const successRecords = [];

    saveResults.forEach((result, i) => {
        const doc = validDocs[i];
        if (result.status === "fulfilled") {
            successRecords.push({
                // For BulkImportLog record
                row: doc.rowNum,
                name: doc.name,
                email: doc.email,
                nationalID: doc.nationalID,
                userId: doc.user._id,
                tempPassword: encryptBulkPassword(
                    doc.plainTempPass,
                    HASH_SECRET,
                ),
                status: "created",
                failReason: null,
                emailSent: false,
                // Runtime-only (stripped before log save)
                _userRef: doc.user,
                _plainTempPass: doc.plainTempPass,
            });
        } else {
            // Friendly duplicate error message
            let failReason = result.reason?.message || "Unknown error";
            if (result.reason?.code === 11000) {
                const dupField = Object.keys(result.reason.keyValue || {})[0];
                failReason = `Duplicate ${dupField || "field"} — user already exists.`;
            }
            failedRecords.push({
                row: doc.rowNum,
                name: doc.name,
                email: doc.email,
                nationalID: doc.nationalID,
                userId: null,
                tempPassword: null,
                status: "failed",
                failReason,
                emailSent: false,
            });
        }
    });

    // 7. Create BulkImportLog (strip runtime fields before saving)
    const logRecords = [
        ...successRecords.map(({ _userRef, _plainTempPass, ...r }) => r),
        ...failedRecords,
    ];

    const bulkLog = await BulkImportLog.create({
        importedBy: req.user._id,
        college_id: targetCollegeId,
        totalRows: rows.length,
        created: successRecords.length,
        failed: failedRecords.length,
        records: logRecords,
    });

    // 8. Send emails fire-and-forget
    Promise.allSettled(
        successRecords.map(async (record) => {
            try {
                await new Email(record._userRef, "").sendCredentials(
                    record._plainTempPass,
                );
                record._userRef.credentialEmailSent = true;
                await record._userRef.save({ validateBeforeSave: false });
                await BulkImportLog.updateOne(
                    { _id: bulkLog._id, "records.userId": record.userId },
                    { $set: { "records.$[elem].emailSent": true } },
                    { arrayFilters: [{ "elem.userId": record.userId }] },
                );
            } catch (err) {
                console.error(
                    `❌ Email failed for user ${record.userId}:`,
                    err.message,
                );
            }
        }),
    );

    // 9. Response
    res.status(201).json({
        status: "success",
        data: {
            created: successRecords.length,
            failed: failedRecords.length,
            log: { id: bulkLog._id },
        },
    });
});

/**
 * Resend credentials for failed email deliveries in a Bulk Import.
 * @async
 * @function resendCredentials
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Contains the logId.
 * @param {string} req.body.logId - ID of the BulkImportLog.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>}
 */
export const resendCredentials = catchAsync(async (req, res, next) => {
    const { logId } = req.body;

    if (!logId) {
        return next(new AppError("logId is required.", 400));
    }

    // Find the log and populate the created users
    const log = await BulkImportLog.findById(logId).populate("records.userId");

    if (!log) {
        return next(new AppError("Import log not found.", 404));
    }

    // Scope checking for CollegeAdmin
    if (
        req.user.role === "collegeAdmin" &&
        log.college_id.toString() !== req.user.college_id.toString()
    ) {
        return next(
            new AppError(
                "You do not have permission to access logs from this college.",
                403,
            ),
        );
    }

    const SECRET = process.env.HASH_SECRET;
    if (!SECRET) {
        return next(
            new AppError(
                "Server configuration error: HASH_SECRET is missing.",
                500,
            ),
        );
    }

    // Filter records that successfully created a user but failed to send the email
    const recordsToResend = log.records.filter(
        (r) =>
            r.status === "created" &&
            r.emailSent === false &&
            r.tempPassword &&
            r.userId,
    );

    if (recordsToResend.length === 0) {
        return res.status(200).json({
            status: "success",
            message: "No pending emails found in this log.",
            data: { sent: 0, failed: 0, total: 0 },
        });
    }

    // Await results for accurate feedback
    const results = await Promise.allSettled(
        recordsToResend.map(async (record) => {
            const plainPassword = decryptBulkPassword(
                record.tempPassword,
                SECRET,
            );
            if (!plainPassword) {
                throw new Error(
                    "Decryption failed — password may have been wiped.",
                );
            }

            const userDoc = record.userId;
            if (!userDoc) {
                throw new Error("User document not found.");
            }

            // Send email
            await new Email(userDoc, "").sendCredentials(plainPassword);

            // Update user document
            userDoc.credentialEmailSent = true;
            await userDoc.save({ validateBeforeSave: false });

            // Update the log record
            await BulkImportLog.updateOne(
                { _id: log._id, "records._id": record._id },
                { $set: { "records.$.emailSent": true } },
            );
        }),
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    // Log failures for debugging
    results.forEach((r, i) => {
        if (r.status === "rejected") {
            const recordId = recordsToResend[i]._id;
            console.error(
                `❌ Resend failed for log record ${recordId}:`,
                r.reason?.message,
            );
        }
    });

    res.status(200).json({
        status: "success",
        message: `Triggered email resend for ${recordsToResend.length} users.`,
        data: {
            sent,
            failed,
            total: recordsToResend.length,
        },
    });
});
