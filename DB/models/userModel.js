import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import { encrypt, decrypt, hashForSearch } from "../../src/utils/cryptoUtils.js";

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Name is required"],
        trim: true,
        validate: {
            validator: function(v) {
                return /^[a-zA-Z\s]+$/.test(v);
            },
            message: props => `${props.value} is not a valid name!`
        }
    },
    email: {
        type: String,
        required: [true, "Email is required"],
        unique: true,
        lowercase: true,
        trim: true,
        index: true,
        validate: {
            validator: function(v) {
                return /^\S+@\S+\.\S+$/.test(v);
            },
            message: props => `${props.value} is not a valid email!`
        }
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        select: false,
        validate: {
            validator: function(v) {
                return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?_#-])[A-Za-z\d@$!%*?_#-]{8,}$/.test(v);
            },
            message: props => `Password must be at least 8 chars long, contain upper & lower case letters, a number, and a special char (@$!%*?_#-). Unsafe chars (<>&"') are not allowed.`
        }
    },
    tempPassword: {
        type: String,
        select: false 
    },
    role: {
        type: String,
        required: [true, "Role is required"],
        enum: ['student', 'ta', 'doctor', 'collegeAdmin', 'universityAdmin']
    },
    rfidTag: {
        type: String,
        unique: true,
        sparse: true, // For RFID-enabled users
        trim: true
    },
    photo: {
        type: String, // URL from Cloudinary
        default: "default_profile.jpg"
    },
    nationalID: {
        type: String,
        required: [true, "National ID is required"],
        select: false,
        // validate: {
        //     validator: function(v) {
        //         return /^[0-9]{14}$/.test(v);
        //     },
        //     message: props => `${props.value} is not a valid national ID!`
        // }
    },
    nationalIDHash: {
        type: String,
        unique: true,
        index: true,
        select: false
    },
    phoneNumber: {
        type: String,
        unique: true,
        trim: true,
        validate: {
            validator: function(v) {
                return /^01[0125][0-9]{8}$/.test(v); // Egyptian Phone Number format
            },
            message: props => `${props.value} is not a valid phone number!`
        }
    },
    department_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        // required: [true, "Department is required"]
    },
    active: {
        type: Boolean,
        default: true
    },
    academicStatus: {
        type: String,
        enum: ['good_standing', 'probation', 'honors'],
        default: 'good_standing'
    },
    // --- Progressive Lockout Fields ---
    loginAttempts: {
        type: Number,
        default: 0
    },
    lockUntil: {
        type: Date
    },
    lockoutStage: {
        type: Number,
        default: 0
    },

    // --- 2FA Fields ---
    twoFactorSecret: {
        type: String,
        select: false
    },
    twoFactorExpires: {
        type: Date
    },

    lastLoginAt: {
        type: Date,
        default: null
    },
    passwordChangedAt: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,

}, { timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

userSchema.virtual('realNationalID').get(function() {
    if (!this.nationalID) return undefined;
    try {
        return decrypt(this.nationalID);
    } catch (err) {
        return null;
    }
});

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return;

    this.password = await bcrypt.hash(this.password, 12);

    if (!this.isNew) {
        this.passwordChangedAt = Date.now() - 1000;
    }
});

userSchema.pre('save', function() {
    if (!this.isModified('nationalID')) return;
    
    // 1. Hash the PLAIN text first (for searching)
    this.nationalIDHash = hashForSearch(this.nationalID);

    // 2. Encrypt the PLAIN text (for storage)
    this.nationalID = encrypt(this.nationalID);
});


userSchema.pre(/^find/, function () {
    this.find({ active: { $ne: false } });
});

userSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

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

userSchema.methods.createPasswordResetToken = function() {
    const resetToken = crypto.randomBytes(32).toString('hex');

    this.passwordResetToken = crypto
        .createHash('sha256')
        .update(resetToken)
        .digest('hex');

    // Token expires in 10 minutes
    this.passwordResetExpires = Date.now() + 10 * 60 * 1000;

    return resetToken;
};

userSchema.methods.correctOTP = async function(candidateOTP) {
    const hashedOTP = crypto.createHash('sha256').update(candidateOTP).digest('hex');
    const hashedOTPBuffer = Buffer.from(hashedOTP);
    const secretBuffer = Buffer.from(this.twoFactorSecret);

    if (hashedOTPBuffer.length !== secretBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(hashedOTPBuffer, secretBuffer);
};

userSchema.methods.saveTwoFactorCode = function(otp) {
    this.twoFactorSecret = crypto
        .createHash('sha256')
        .update(otp)
        .digest('hex');
    this.twoFactorExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
};

userSchema.methods.isTwoFactorExpired = function() {
    return this.twoFactorExpires < Date.now();
};

const User = mongoose.model("User", userSchema);
export default User;
