/**
 * ===================================================================================
 * @file      userModel.js
 * @desc      Mongoose model for User entity. Handles identity, authentication,
 *            encryption (Blind Indexing), RBAC, and security policies (Lockout, 2FA).
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    DB/Models/User
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import {
    encrypt,
    decrypt,
    hashForSearch,
} from "../../src/utils/cryptoUtils.js";

const userSchema = new mongoose.Schema(
    {
        // --- Personal Information ---
        name: {
            type: String,
            required: [true, "Name is required"],
            trim: true,
            validate: {
                validator: function (v) {
                    return /^[a-zA-Z\s]+$/.test(v);
                },
                message: (props) => `${props.value} is not a valid name!`,
            },
        },
        email: {
            type: String,
            required: [true, "Email is required"],
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
            validate: {
                validator: function (v) {
                    return /^\S+@\S+\.\S+$/.test(v);
                },
                message: (props) => `${props.value} is not a valid email!`,
            },
        },
        /** * @field password - Stored as bcrypt hash. Never returned in queries by default.
         */
        password: {
            type: String,
            required: [true, "Password is required"],
            select: false,
            validate: {
                validator: function (v) {
                    // If it is already a bcrypt hash, bypass the validation check
                    if (/^\$2[ayb]\$[0-9]{2}\$[A-Za-z0-9./]{53}$/.test(v))
                        return true;
                    // Otherwise validate plain text strength
                    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?_#-])[A-Za-z\d@$!%*?_#-]{12,}$/.test(
                        v,
                    );
                },
                message: (props) =>
                    `Password must be at least 12 chars long, contain upper & lower case letters, a number, and a special char (@$!%*?_#-). Unsafe chars (<>&"') are not allowed.`,
            },
        },
        tempPassword: {
            type: String,
            select: false,
            validate: {
                validator: function (v) {
                    if (!v) return true;
                    // If it is already encrypted (starts with 32 hex chars IV followed by a colon and hex content)
                    if (/^[a-f0-9]{32}:[a-f0-9]+$/.test(v)) return true;
                    // Otherwise validate plain text password strength rules
                    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?_#-])[A-Za-z\d@$!%*?_#-]{12,}$/.test(
                        v,
                    );
                },
                message: (props) =>
                    `Password must be at least 12 chars long, contain upper & lower case letters, a number, and a special char (@$!%*?_#-). Unsafe chars (<>&"') are not allowed.`,
            },
        },
        // --- Role & Identification ---
        role: {
            type: String,
            enum: [
                "student",
                "ta",
                "doctor",
                "collegeAdmin",
                "universityAdmin",
            ],
            default: "student",
        },
        /**
         * @field rfidTag - Unique RFID card tag identifier.
         * @deprecated Phase 5 switched from RFID to biometric fingerprint attendance.
         * Retained as sparse/optional field for potential future multi-factor use
         * (e.g., RFID + fingerprint two-factor check-in). Safe to leave in schema.
         */
        rfidTag: {
            type: String,
            unique: true,
            sparse: true, // Allows null values for users without tags (e.g. admins)
            trim: true,
        },
        photo: {
            type: String, // URL from Cloudinary
            default: "default_profile.jpg",
        },

        // --- Secure National ID Strategy (Blind Indexing) ---
        /** * @field nationalID - Two-way encrypted string. Used for display/retrieval only. Cannot be searched.
         */
        nationalID: {
            type: String,
            required: [true, "National ID is required"],
            select: false,
            validate: {
                validator: function (v) {
                    // Runs on plain text — encryption happens in pre-save hook AFTER validation
                    // For findOneAndUpdate, pass { runValidators: true } in options
                    return /^[0-9]{14}$/.test(v);
                },
                message: (props) =>
                    `${props.value} is not a valid national ID!`,
            },
        },
        /** * @field nationalIDHash - One-way deterministic hash. Used for searching and uniqueness enforcement.
         */
        nationalIDHash: {
            type: String,
            unique: true,
            index: true,
            select: false,
        },
        phoneNumber: {
            type: String,
            unique: true,
            trim: true,
            validate: {
                validator: function (v) {
                    return /^01[0125][0-9]{8}$/.test(v); // Egyptian Phone Number format
                },
                message: (props) =>
                    `${props.value} is not a valid phone number!`,
            },
        },

        // --- Organizational Link ---
        department_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Department",
        },
        /**
         * @field college_id - Direct college reference for fast scoping of collegeAdmin queries.
         * Avoids the department → college join on every admin request.
         */
        college_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "College",
            index: true,
        },

        // --- Student Academic Info ---
        // These fields are only meaningful for the 'student' role.
        // select: false hides them from all default queries — controllers that need them
        // (gradebook, enrollment, student profile) must explicitly request with +fieldName.
        level: {
            type: Number,
            enum: [1, 2, 3, 4, 5],
            default: 1,
            sparse: true,
            select: false,
        },
        gpa: {
            type: Number,
            min: 0,
            max: 4.0,
            default: 0.0,
            sparse: true,
            select: false,
        },
        earnedCredits: {
            type: Number,
            default: 0,
            sparse: true,
            select: false,
        },
        academicStatus: {
            type: String,
            enum: [
                "good_standing",
                "probation",
                "honors",
                "graduated",
                "suspended",
            ],
            default: "good_standing",
            select: false,
        },

        // --- Status & Logic ---
        active: {
            type: Boolean,
            default: true,
        },
        /**
         * @field requiresPasswordChange - Set to true when admin generates a temp password.
         * The protect middleware will block all requests until the user changes their password.
         */
        requiresPasswordChange: {
            type: Boolean,
            default: false,
            select: false, // F-06: never expose account security state in API responses
        },
        /**
         * @field tokensInvalidatedAt - When set, all JWT tokens issued before this timestamp are invalid.
         * Used for force-logout and admin password reset to immediately terminate all active sessions.
         */
        tokensInvalidatedAt: {
            type: Date,
            select: false, // F-06: internal session management — not for client consumption
        },
        /**
         * @field credentialEmailSent - Tracks whether initial credentials email was successfully delivered.
         * Used in conjunction with BulkImportLog for retry tracking.
         */
        credentialEmailSent: {
            type: Boolean,
            default: false,
            select: false,
        },
        // --- Progressive Lockout Fields ---
        loginAttempts: {
            type: Number,
            default: 0,
            select: false, // F-06: never expose lockout progress to clients
        },
        lockUntil: {
            type: Date,
            select: false, // F-06: never expose lockout timing to clients
        },
        lockoutStage: {
            type: Number,
            default: 0,
            select: false, // F-06: never expose lockout algorithm internals to clients
        },

        // --- Two-Factor Authentication (2FA) ---
        twoFactorSecret: {
            type: String,
            select: false,
        },
        twoFactorExpires: {
            type: Date,
            select: false, // F-06: internal 2FA state — not for client consumption
        },

        // --- Account Security Timestamps ---
        lastLoginAt: {
            type: Date,
            default: null,
            select: false, // F-06: internal session guard — queried explicitly in authMiddleware
        },
        passwordChangedAt: { type: Date, select: false }, // F-06: queried explicitly for token rotation guard
        passwordResetToken: { type: String, select: false },
        passwordResetExpires: { type: Date, select: false },

        /**
         * @field lastEnrollmentAttempt - Write-lock sentinel for the enrollment engine.
         * Updated inside withTransaction() as the FIRST operation to force
         * a WriteConflict when two concurrent transactions target the same student.
         * Prevents the "Phantom Credit Bypass" caused by MongoDB Snapshot Isolation.
         */
        lastEnrollmentAttempt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        toJSON: {
            virtuals: true,
            transform: (doc, ret) => {
                // F-02: never expose the decrypted National ID in any API response.
                // realNationalID is a virtual getter — it fires on every toJSON call.
                // Internal code that needs the value must call .toObject({ virtuals: true })
                // and read realNationalID directly from the result object.
                delete ret.realNationalID;
                // F-06: remove MongoDB internal version key (__v) from all responses.
                delete ret.__v;
                return ret;
            },
        },
        toObject: { virtuals: true },
    },
);

// ===========================================
// VIRTUALS
// ===========================================

/**
 * Virtual property to decrypt National ID on the fly.
 * Usage: user.realNationalID
 * @returns {string|null} The decrypted National ID or null if decryption fails.
 */
userSchema.virtual("realNationalID").get(function () {
    if (!this.nationalID) return undefined;
    try {
        return decrypt(this.nationalID);
    } catch (err) {
        return null;
    }
});

// ===========================================
// DOCUMENT MIDDLEWARE (HOOKS)
// ===========================================

/**
 * Pre-save hook: Hash password and update `passwordChangedAt`.
 * Runs only if password field is modified.
 */
userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return;

    this.password = await bcrypt.hash(this.password, 12);

    if (!this.isNew) {
        this.passwordChangedAt = new Date();
    }
});

/**
 * Pre-save hook: Strip student-only academic fields for non-student roles.
 *
 * MongoDB will store default values (level:1, gpa:0, earnedCredits:0,
 * academicStatus:"good_standing") on every document unless we explicitly
 * unset them. For doctors, admins, and TAs these fields are meaningless
 * and should never exist in the database.
 *
 * Runs on create and whenever the role field is changed.
 */
userSchema.pre("save", function () {
    if (this.role !== "student") {
        this.level = undefined;
        this.gpa = undefined;
        this.earnedCredits = undefined;
        this.academicStatus = undefined;
    }
});

/**
 * Pre-save hook: Handle National ID Security (Blind Indexing).
 * 1. Hashes plain text for searchability (`nationalIDHash`).
 * 2. Encrypts plain text for storage (`nationalID`).
 */
userSchema.pre("save", function () {
    if (!this.isModified("nationalID")) return;

    // 1. Hash the PLAIN text first (for searching)
    this.nationalIDHash = hashForSearch(this.nationalID);

    // 2. Encrypt the PLAIN text (for storage)
    this.nationalID = encrypt(this.nationalID);
});

/**
 * Pre-save hook: Encrypt temporary password.
 * Runs only if tempPassword is set/modified.
 */
userSchema.pre("save", function () {
    if (!this.isModified("tempPassword") || !this.tempPassword) return;

    this.tempPassword = encrypt(this.tempPassword);
});

// ===========================================
// QUERY MIDDLEWARE
// ===========================================

/**
 * Pre-find hook: Filter out inactive users (Soft Delete implementation).
 * Applies to all queries starting with 'find'.
 */
userSchema.pre(/^find|countDocuments/, function () {
    if (this.options && this.options.skipActiveCheck) return;
    this.find({ active: { $ne: false } });
});

// ===========================================
// INSTANCE METHODS
// ===========================================

/**
 * Compares candidate password with stored hashed password.
 * @param {string} candidatePassword - The password provided by user.
 * @returns {Promise<boolean>} True if match, False otherwise.
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

/**
 * Checks if the user changed password after the JWT token was issued.
 * @param {number} JWTTimestamp - The time the token was issued (iat).
 * @returns {boolean} True if password was changed AFTER token issuance.
 */
userSchema.methods.changedPasswordAfter = function (JWTTimestamp) {
    if (this.passwordChangedAt) {
        const changedTimestamp = parseInt(
            this.passwordChangedAt.getTime() / 1000,
            10,
        ); // Convert to seconds
        // console.log(changedTimestamp, JWTTimestamp);
        return JWTTimestamp < changedTimestamp; // If JWT timestamp is less than the changed timestamp, password was changed after the token was issued
    }

    return false;
};

/**
 * Generates a random reset token for password recovery.
 * Hashes the token for storage and sets expiration.
 * @returns {string} The unhashed reset token to be sent via email.
 */
userSchema.methods.createPasswordResetToken = function () {
    const resetToken = crypto.randomBytes(32).toString("hex");

    this.passwordResetToken = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

    // Token expires in 10 minutes
    this.passwordResetExpires = Date.now() + 10 * 60 * 1000;

    return resetToken;
};

/**
 * Verifies the provided 2FA OTP against the stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} candidateOTP - The OTP provided by the user.
 * @returns {Promise<boolean>} True if valid.
 */
userSchema.methods.correctOTP = async function (candidateOTP) {
    // Safety check
    if (!this.twoFactorSecret) return false;

    const hashedOTP = crypto
        .createHash("sha256")
        .update(candidateOTP)
        .digest("hex");
    const hashedOTPBuffer = Buffer.from(hashedOTP);
    const secretBuffer = Buffer.from(this.twoFactorSecret);

    // Prevent Length Extension Attacks / Timing issues on length
    if (hashedOTPBuffer.length !== secretBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(hashedOTPBuffer, secretBuffer);
};

/**
 * Generates and stores a hashed 2FA secret (OTP).
 * @param {string} otp - The plain OTP code generated in controller.
 */
userSchema.methods.saveTwoFactorCode = function (otp) {
    this.twoFactorSecret = crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");
    this.twoFactorExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
};

/**
 * Checks if the stored 2FA code has expired.
 * @returns {boolean} True if expired.
 */
userSchema.methods.isTwoFactorExpired = function () {
    return this.twoFactorExpires < Date.now();
};

const User = mongoose.model("User", userSchema);
export default User;
