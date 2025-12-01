import mongoose from "mongoose";
import bcrypt from "bcryptjs";

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
        select: false, // Hashed
        validate: {
            validator: function(v) {
                return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?_#-])[A-Za-z\d@$!%*?_#-]{8,}$/.test(v);
            },
            message: props => `Password must be at least 8 chars long, contain upper & lower case letters, a number, and a special char (@$!%*?_#-). Unsafe chars (<>&"') are not allowed.`
        }
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
        unique: true,
        trim: true,
        validate: {
            validator: function(v) {
                return /^[0-9]{14}$/.test(v);
            },
            message: props => `${props.value} is not a valid national ID!`
        }
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
    passwordChangedAt: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,

    lastLoginAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();

    this.password = await bcrypt.hash(this.password, 12);

    if (!this.isNew) {
        this.passwordChangedAt = Date.now() - 1000;
    }
    
    next();
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

const User = mongoose.model("User", userSchema);
export default User;
