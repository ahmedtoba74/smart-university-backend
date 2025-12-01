import User from "../../../DB/models/userModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const signToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN
    });
};

const createSendToken = (user, statusCode, res) => {
    const token = signToken(user._id);
    const cookieOptions = {
        expires: new Date(Date.now() + Number(process.env.JWT_COOKIE_EXPIRES_IN) * 60 * 60 * 1000),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production'
    };
    res.cookie('jwt', token, cookieOptions);
    user.password = undefined;
    res.status(statusCode).json({
        status: 'success',
        message: 'Login successful',
        data: {
            user
        }
    });
};

export const login = catchAsync(async (req, res, next) => {
    console.log(req.body);  
    const { email, password } = req.body;
    if (!email || !password) {
        return next(new AppError('Please provide email and password', 400));
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
        return next(new AppError('User not found', 404));
    }

    if (!user.comparePassword(password)) {
        return next(new AppError('Incorrect password', 401));
    }
    
    await User.findByIdAndUpdate(user._id, { lastLoginAt: Date.now() - 1000 });

    createSendToken(user, 200, res);
})