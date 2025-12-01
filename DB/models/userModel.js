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
                return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(v);
            },
            message: props => `${props.value} is not a valid password!`
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

userSchema.pre('save', async function() {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 12);
    }
});

userSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.pre(/^find/, function () {
    this.find({ active: { $ne: false } });
});

const User = mongoose.model("User", userSchema);
export default User;
