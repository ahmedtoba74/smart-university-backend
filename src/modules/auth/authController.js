import User from "../../../DB/models/userModel.js";
import BulkImportLog from "../../../DB/models/bulkImportLogModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Email from "../../services/email.js";
import { hashForSearch, encrypt, decrypt } from "../../utils/cryptoUtils.js";

// ===========================================
// 1) Helper Functions
// ===========================================

/**
 * Sign a JWT token.
 * @function signToken
 * @param {string} id - User ID.
 * @returns {string} Signed JWT token.
 */
const signToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });
};

/**
 * Type-safe OTP expiry check for Mongoose documents.
 * Avoids relying on instance-method typing in editor diagnostics.
 * @param {Object} user
 * @returns {boolean}
 */
const isOtpExpired = (user) => {
    if (!user?.twoFactorExpires) return true;
    return new Date(user.twoFactorExpires).getTime() < Date.now();
};

/**
 * Create and send a token as a cookie and in the response.
 * @function createSendToken
 * @param {Object} user - User object.
 * @param {number} statusCode - HTTP status code.
 * @param {Object} res - Express response object.
 * @param {string} [msg="Processed successfully"] - Success message.
 */
const createSendToken = (
    user,
    statusCode,
    res,
    msg = "Processed successfully",
) => {
    const token = signToken(user._id);
    const cookieOptions = {
        expires: new Date(
            Date.now() +
                Number(process.env.JWT_COOKIE_EXPIRES_IN) * 60 * 60 * 1000,
        ),
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
    };
    res.cookie("jwt", token, cookieOptions);
    user.password = undefined;
    user.twoFactorSecret = undefined;
    user.nationalIDHash = undefined;
    user.nationalID = undefined;
    res.status(statusCode).json({
        status: "success",
        message: msg,
        token,
        data: {
            user,
        },
    });
};

/**
 * Handles login failure by updating user's login attempts and lockout stage.
 * @param {User} user - The user object.
 * @returns {Promise<void>}
 * @throws {Error} If the user is not found.
 */
/**
 * Handle login failure logic (lockout mechanism).
 * @async
 * @function handleLoginFailure
 * @param {Object} user - User object.
 * @returns {Promise<void>}
 */
async function handleLoginFailure(user) {
    user.loginAttempts += 1;
    let lockDuration = 0;

    // Logic: 5 -> 30m, 5 -> 1h, 3 -> 2h, 1 -> 3h, 1 -> Deactivate
    if (user.lockoutStage === 0 && user.loginAttempts >= 5) {
        user.lockoutStage = 1;
        user.loginAttempts = 0;
        lockDuration = 30 * 60 * 1000;
    } else if (user.lockoutStage === 1 && user.loginAttempts >= 5) {
        user.lockoutStage = 2;
        user.loginAttempts = 0;
        lockDuration = 60 * 60 * 1000;
    } else if (user.lockoutStage === 2 && user.loginAttempts >= 3) {
        user.lockoutStage = 3;
        user.loginAttempts = 0;
        lockDuration = 2 * 60 * 60 * 1000;
    } else if (user.lockoutStage === 3 && user.loginAttempts >= 1) {
        user.lockoutStage = 4;
        user.loginAttempts = 0;
        lockDuration = 3 * 60 * 60 * 1000;
    } else if (user.lockoutStage === 4 && user.loginAttempts >= 1) {
        user.active = false; // Kill Switch
    }

    if (lockDuration > 0) user.lockUntil = Date.now() + lockDuration;
    await user.save({ validateBeforeSave: false });
}

// ===========================================
// 2) CONTROLLERS
// ===========================================

/**
 * Step 1 of Login: Validate credentials and send 2FA OTP.
 * @async
 * @function loginStepOne
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.email - User's email.
 * @param {string} req.body.nationalID - User's national ID.
 * @param {string} req.body.password - User's password.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response indicating 2FA code sent.
 */
export const loginStepOne = catchAsync(async (req, res, next) => {
    const { email, nationalID, password } = req.body;
    if (!email || !nationalID || !password) {
        return next(
            new AppError("Please provide email, nationalID and password", 400),
        );
    }

    // Hash National ID for Search
    const hashedNationalID = hashForSearch(nationalID);

    // Find User (Include security fields)
    const user = await User.findOne({
        email,
        nationalIDHash: hashedNationalID,
    }).select("+password +loginAttempts +lockUntil +lockoutStage");

    // Security Check: Is Account Locked?
    if (user && user.lockUntil && user.lockUntil > Date.now()) {
        const waitMinutes = Math.ceil(
            (user.lockUntil - Date.now()) / (60 * 1000),
        );
        return next(
            new AppError(
                `Account locked. Try again in ${waitMinutes} minutes.`,
                429,
            ),
        );
    }

    // Security Check: Credentials
    if (!user || !(await user.comparePassword(password))) {
        if (user) await handleLoginFailure(user); // Apply Penalty
        return next(new AppError("Incorrect credentials", 401));
    }

    // Security Check: Account Status
    if (!user.active) {
        return next(
            new AppError(
                "Your account has been deactivated. Contact admin.",
                401,
            ),
        );
    }

    // === Success ===

    // TEMPORARY: Bypass OTP for testing/development. Return token directly.
    if (user.loginAttempts > 0 || user.lockUntil) {
        user.loginAttempts = 0;
        user.lockoutStage = 0;
        user.lockUntil = undefined;
    }
    user.lastLoginAt = Date.now();
    await user.save({ validateBeforeSave: false });

    return createSendToken(
        user,
        200,
        res,
        "Logged in successfully (OTP disabled for testing)",
    );

    /* --- TEMPORARILY DISABLED OTP LOGIC ---
    // NOTE: We do NOT reset lockout counters here anymore.
    // This prevents attackers from resetting their failed attempts by re-authenticating Step 1.

    // 2. Generate OTP
    // Use crypto.randomInt instead of Math.random — cryptographically secure
    const otp = crypto.randomInt(100000, 999999).toString();

    // 3. Hash OTP & Save
    user.saveTwoFactorCode(otp);
    await user.save({ validateBeforeSave: false });

    // 4. Send Email
    try {
        const loginUrl = `${req.protocol}://${req.get("host")}/login/verify`;
        await new Email(user, loginUrl).send2FACode(otp, "Login");
        res.status(200).json({
            status: "success",
            message: "2FA Code sent to your email.",
        });
    } catch (err) {
        console.error("❌ [loginStepOne] Email Error:", err);
        user.twoFactorSecret = undefined;
        user.twoFactorExpires = undefined;
        await user.save({ validateBeforeSave: false });
        return next(new AppError(`Error sending email. Try again!`, 500));
    }
    ----------------------------------------- */
});

// 2. Login Step 2: Verify OTP & Issue Token
/**
 * Step 2 of Login: Verify OTP and issue JWT token.
 * @async
 * @function loginStepTwo
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.email - User's email.
 * @param {string} req.body.otp - One-Time Password.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response with the JWT token.
 */
export const loginStepTwo = catchAsync(async (req, res, next) => {
    const { email, otp } = req.body;

    if (!email || !otp)
        return next(new AppError("Please provide email and OTP", 400));

    const user = await User.findOne({
        email,
    }).select(
        "+twoFactorSecret +twoFactorExpires +loginAttempts +lockUntil +lockoutStage",
    );

    if (!user) return next(new AppError("Invalid email or OTP expired", 400));

    // Security Check: OTP Expiry
    if (isOtpExpired(user)) {
        return next(
            new AppError(
                "OTP has expired. Please login again to get a new code.",
                401,
            ),
        );
    }

    // Security Check: Is Account Locked?
    if (user.lockUntil && user.lockUntil > Date.now()) {
        const waitMinutes = Math.ceil(
            (user.lockUntil - Date.now()) / (60 * 1000),
        );
        return next(
            new AppError(
                `Account locked. Try again in ${waitMinutes} minutes.`,
                429,
            ),
        );
    }

    // Verify OTP
    if (!(await user.correctOTP(otp))) {
        await handleLoginFailure(user);
        return next(new AppError("Incorrect OTP", 401));
    }

    // 1. Reset Lockout Counters
    if (user.loginAttempts > 0 || user.lockUntil) {
        user.loginAttempts = 0;
        user.lockoutStage = 0;
        user.lockUntil = undefined;
    }

    // Clear 2FA fields
    user.twoFactorSecret = undefined;
    user.twoFactorExpires = undefined;

    // Update Last Login (For Single Session)
    user.lastLoginAt = Date.now();
    await user.save({ validateBeforeSave: false });

    createSendToken(user, 200, res, "Logged in successfully");
});

/**
 * Initiate password update process.
 * @async
 * @function initiateUpdatePassword
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.currentPassword - Current password.
 * @param {string} req.body.password - New password.
 * @param {string} req.body.passwordConfirm - Confirm new password.
 * @param {Object} req.user - Authenticated user object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response indicating OTP sent.
 */
export const initiateUpdatePassword = catchAsync(async (req, res, next) => {
    const { currentPassword, password, passwordConfirm } = req.body;
    if (!currentPassword || !password || !passwordConfirm) {
        return next(
            new AppError(
                "Please provide currentPassword, password, and passwordConfirm",
                400,
            ),
        );
    }
    if (password !== passwordConfirm) {
        return next(new AppError("Passwords do not match", 400));
    }
    const user = await User.findById(req.user.id).select("+password");
    if (!user) {
        return next(new AppError("User not found", 404));
    }
    if (!(await user.comparePassword(currentPassword))) {
        return next(new AppError("Incorrect password", 401));
    }
    if (password === currentPassword) {
        return next(
            new AppError(
                "New password cannot be the same as current password",
                400,
            ),
        );
    }

    user.tempPassword = encrypt(password);

    // Use crypto.randomInt instead of Math.random — cryptographically secure
    const otp = crypto.randomInt(100000, 999999).toString();
    user.saveTwoFactorCode(otp);

    await user.save({ validateBeforeSave: false });

    try {
        const loginUrl = `${req.protocol}://${req.get("host")}/updatePassword/confirm`;
        await new Email(user, loginUrl).send2FACode(otp, "Update Password");
        res.status(200).json({
            status: "success",
            message:
                "OTP sent to your email. Please complete to update password.",
        });
    } catch (err) {
        user.twoFactorSecret = undefined;
        user.twoFactorExpires = undefined;
        await user.save({ validateBeforeSave: false });
        return next(new AppError(`Error sending email. Try again!`, 500));
    }
});

/**
 * Confirm password update with OTP.
 * @async
 * @function confirmUpdatePassword
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.otp - One-Time Password.
 * @param {Object} req.user - Authenticated user object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response confirming password update.
 */
export const confirmUpdatePassword = catchAsync(async (req, res, next) => {
    const { otp } = req.body;
    if (!otp) {
        return next(new AppError("Please provide OTP", 400));
    }
    const user = await User.findById(req.user.id).select(
        "+twoFactorSecret +twoFactorExpires +tempPassword",
    );

    if (!user) {
        return next(new AppError("User not found", 404));
    }

    if (!user.tempPassword) {
        return next(
            new AppError(
                "No pending password update found. Please start over.",
                400,
            ),
        );
    }

    if (isOtpExpired(user)) {
        return next(
            new AppError(
                "OTP has expired. Please login again to get a new code.",
                401,
            ),
        );
    }
    if (!(await user.correctOTP(otp))) {
        return next(new AppError("Incorrect OTP", 401));
    }

    const decryptedPassword = decrypt(user.tempPassword);

    user.password = decryptedPassword;

    user.tempPassword = undefined;
    user.twoFactorSecret = undefined;
    user.twoFactorExpires = undefined;

    // Invalidate all existing sessions immediately after password change
    user.tokensInvalidatedAt = new Date();

    // Flip requiresPasswordChange in case this flow was triggered by a temp password
    user.requiresPasswordChange = false;

    await user.save();

    // Null out tempPassword in BulkImportLog for this user
    // (TTL alone is not sufficient — temp passwords must be cleared immediately on change)
    await BulkImportLog.updateMany(
        {
            "records.userId": user._id,
            "records.tempPassword": { $ne: null },
        },
        {
            $set: { "records.$[elem].tempPassword": null },
        },
        {
            arrayFilters: [
                { "elem.userId": user._id, "elem.tempPassword": { $ne: null } },
            ],
        },
    );

    createSendToken(user, 200, res, "Password updated successfully");
});

/**
 * Initiate forgot password process.
 * @async
 * @function forgotPassword
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.email - User's email.
 * @param {string} req.body.nationalID - User's national ID.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response indicating reset token sent.
 */
export const forgotPassword = catchAsync(async (req, res, next) => {
    const { email, nationalID } = req.body;

    if (!email || !nationalID) {
        return next(new AppError("Please provide email and nationalID", 400));
    }

    const hashedNationalID = hashForSearch(nationalID);
    const user = await User.findOne({
        email,
        nationalIDHash: hashedNationalID,
    });
    if (!user) {
        return next(
            new AppError("User not found with these credentials.", 404),
        );
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetURL = `${req.protocol}://${req.get("host")}/api/v1/auth/resetPassword/${resetToken}`;

    try {
        await new Email(user, resetURL).sendPasswordReset();

        res.status(200).json({
            status: "success",
            message: "Token sent to email!",
        });
    } catch (err) {
        console.log("❌ Email Error:", err);

        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });

        return next(
            new AppError(
                "There was an error sending the email. Try again later!",
            ),
            500,
        );
    }
});

/**
 * Reset password using token.
 * @async
 * @function resetPassword
 * @param {Object} req - Express request object.
 * @param {Object} req.params - Request parameters.
 * @param {string} req.params.token - Reset token.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.password - New password.
 * @param {string} req.body.passwordConfirm - Confirm new password.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response confirming password reset.
 */
export const resetPassword = catchAsync(async (req, res, next) => {
    const { password, passwordConfirm } = req.body;

    if (!password || !passwordConfirm) {
        return next(
            new AppError("Please provide password and passwordConfirm", 400),
        );
    }
    if (password !== passwordConfirm) {
        return next(new AppError("Passwords do not match", 400));
    }
    const hashedToken = crypto
        .createHash("sha256")
        .update(req.params.token)
        .digest("hex");

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
        return next(new AppError("Token is invalid or has expired", 400));
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    // Invalidate all existing sessions after successful password reset
    user.tokensInvalidatedAt = new Date();

    await user.save();

    createSendToken(user, 200, res, "Password reset successfully");
});

/**
 * Logout user by clearing the JWT cookie.
 * @async
 * @function logout
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>} Sends a JSON response confirming logout.
 */
export const logout = catchAsync(async (req, res, next) => {
    res.cookie("jwt", "loggedout", {
        expires: new Date(Date.now() + 10 * 1000),
        httpOnly: true,
    });
    res.status(200).json({
        status: "success",
        message: "Logged out successfully",
    });
});
