import express from 'express';
import dotenv from 'dotenv';

import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import hpp from 'hpp';
import compression from 'compression';
import sanitize from 'express-mongo-sanitize';
import AppError from './src/utils/appError.js';
import globalErrorHandler from './src/utils/errorHandler.js';

import userRouter from './src/modules/users/userRouter.js';
import authRouter from './src/modules/auth/authRouter.js';

// Load env vars
dotenv.config();

const app = express();

// 1- Global Middleware

// Enable CORS
app.use(cors());

//  Development logging
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Limit requests from same API
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again after 10 minutes'
});

// Apply rate limiter to all requests
app.use('/api', limiter);

app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// Data sanitization against NoSQL query injection
// app.use(sanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Secure app by setting headers
app.use(helmet());

// Compress text responses
app.use(compression());

// Parse cookies
app.use(cookieParser());

// Test router
app.get('/api/v1/test', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Test route'
    });
});

// Router
app.use('/api/v1/users', userRouter);
app.use('/api/v1/auth', authRouter);

// Handle Unhandled Routes
app.all(/(.*)/, (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global Error Handler
app.use(globalErrorHandler);

export default app;