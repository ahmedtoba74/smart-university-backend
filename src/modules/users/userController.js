import User from "../../../DB/models/userModel.js";
import catchAsync from "../../utils/catchAsync.js";

/**
 * Create a new user.
 * @async
 * @function createUser
 * @param {Object} req - Express request object.
 * @param {Object} req.body - The request body containing user details.
 * @param {string} req.body.name - User's name.
 * @param {string} req.body.email - User's email.
 * @param {string} req.body.password - User's password.
 * @param {string} req.body.passwordConfirm - Password confirmation.
 * @param {string} req.body.nationalID - User's national ID.
 * @param {string} [req.body.role] - User's role.
 * @param {string} [req.body.department_id] - User's department ID.
 * @param {string} req.body.phoneNumber - User's phone number.
 * @param {string} [req.body.photo] - User's photo URL.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the created user.
 */
export const createUser = catchAsync(async (req, res, next) => {
    const { name, email, password, passwordConfirm, nationalID, role, department_id, phoneNumber, photo } = req.body;

    if (!name || !email || !password || !passwordConfirm || !nationalID || !phoneNumber) {
        return next(new AppError("Please provide all required fields", 400));
    }

    if (password !== passwordConfirm) {
        return next(new AppError("Password does not match", 400));
    }

    const nationalIDRegex = /^[0-9]{14}$/;
    if (!nationalIDRegex.test(nationalID)) {
        return next(new AppError("Invalid national ID", 400));
    }

    const user = await User.create(
        {
            name, 
            email, 
            password, 
            nationalID, 
            role, 
            department_id, 
            phoneNumber, 
            photo 
        }
    );
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
    // Create a query object
    let query = User.find();

    if (req.query.includeDeleted === 'true') {
        query = query.setOptions({ skipActiveCheck: true });
    }

    const features = new APIFeatures(query, req.query)
    .filter()
    .sort()
    .limitFields()
    .paginate();

    const users = await features.query;

    res.status(200).json({
        status: "success",
        results: users.length,
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
    const user = await User.findById(req.params.id);
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
    const user = await User.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });
    user.password = undefined;
    res.status(201).json({
        status: "success",
        data: {
            user,
        },
    });
});

/**
 * Soft delete a user by setting active to false.
 * @async
 * @function deleteUser
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.id - User ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the updated user status.
 */
export const deleteUser = catchAsync(async (req, res, next) => {
    const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
    if (!user) {
        return next(new AppError("User not found", 404));
    }
    res.status(201).json({
        status: "success",
        message: "User deactivated successfully",
        data: {
            user,
        },
    });
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
    next();
};




