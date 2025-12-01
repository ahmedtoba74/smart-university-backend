import express from 'express';
import dotenv from 'dotenv';

import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import hpp from 'hpp';
import compression from 'compression';
import AppError from './src/utils/appError.js';
import globalErrorHandler from './src/utils/errorHandler.js';
import sanitizer from 'perfect-express-sanitizer';

import userRouter from './src/modules/users/userRouter.js';
import authRouter from './src/modules/auth/authRouter.js';

// Load env vars
dotenv.config();

const app = express();

// ===========================================
// 1) GLOBAL CONFIGURATION & SECURITY
// ===========================================

// Trust proxy
app.enable('trust proxy');

// Enable CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? 'https://your-frontend-domain.com' 
        : true, 
    credentials: true 
}));

// Secure app by setting headers
app.use(helmet());

//  Development logging
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Limit requests from same API
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again after 10 minutes',
    standardHeaders: true, 
    legacyHeaders: false,
});

// Apply rate limiter to all requests
app.use('/api', limiter);


// ===========================================
// 2) BODY PARSING & SANITIZATION
// ===========================================

app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// Data sanitization against NoSQL query injection
app.use(sanitizer.clean({
    xss: true,
    noSql: true,
    sql: false, 
    whitelist: [
        'password', 
        'passwordConfirm', 
        'oldPassword'
    ]
}));

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Compress text responses
app.use(compression());

// Parse cookies
app.use(cookieParser());

// ===========================================
// 3) ROUTES & ERROR HANDLING
// ===========================================

// Test router
app.get('/api/v1/test', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Test route'
    });
});

app.use('/api/v1/users', userRouter);
app.use('/api/v1/auth', authRouter);

// Handle Unhandled Routes
app.all(/(.*)/, (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global Error Handler
app.use(globalErrorHandler);

export default app;