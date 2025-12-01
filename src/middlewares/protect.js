import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import User from '../../DB/models/userModel.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/appError.js';

export const protect = catchAsync(async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.jwt) {
        token = req.cookies.jwt;
    }

    if (!token) {
        return next(
            new AppError('You are not logged in! Please log in to get access.', 401)
        );
    }

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
        return next(
            new AppError('The user belonging to this token no longer exists.', 401)
        );
    }
    if (currentUser.lastLoginAt) {
        const lastLoginTimestamp = parseInt(currentUser.lastLoginAt.getTime() / 1000, 10);
        if (lastLoginTimestamp > decoded.iat) {
            return next(
                new AppError('User recently logged in from another device. Please log in again.', 401)
            );
        }
    }

    // Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next(
            new AppError(
                "User recently changed password! Please log in again.",
                401,
            ),
        );
    }

    req.user = currentUser;
    res.locals.user = currentUser;
    next();
});