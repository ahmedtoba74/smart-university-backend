/**
 * ===================================================================================
 * @project   Smart University Platform
 * "Forging a Secure and Resilient Digital Backbone for a New Era of Academia"
 * ===================================================================================
 * @file      app.js
 * @desc      The core application configuration and middleware setup.
 * This Backend API serves as the central nervous system for the platform,
 * integrating Authentication, Academic Management, LMS, and IoT Attendance.
 * @version   1.0.0
 * @date      2025-2026
 * @author    Ahmed Toba <ahmed.toba.mahmoud@gmail.com> | Team Lead
 * @team      Graduation Project Team - Faculty of Engineering, Beni-Suef University
 * - Ahmed Toba (Backend)
 * - Mahmoud Ahmed (Frontend)
 * - Ahmed Shaban (Penetration Testing)
 * - Rana Tamer (DevOps)
 * - Hadeer Naser (DevOps)
 * - Mahmoud Saleh (Network)
 * - Adham Mahmoud (Network)
 * @supervisors
 * - Asst. Prof. Dr. Fathy El-Messiri
 * - Dr. Mohamed Faysel El-Rawy
 * @license   Proprietary - All Rights Reserved to Beni-Suef University
 * @repository https://github.com/ahmedtoba74/smart-university-backend
 * ===================================================================================
 */

import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";

import morgan from "morgan";
import cookieParser from "cookie-parser";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import hpp from "hpp";
import compression from "compression";
import AppError from "./src/utils/appError.js";
import globalErrorHandler from "./src/utils/errorHandler.js";
import sanitizer from "perfect-express-sanitizer";
import toobusy from "toobusy-js";

import userRouter from "./src/modules/users/userRouter.js";
import authRouter from "./src/modules/auth/authRouter.js";
import collegeRouter from "./src/modules/colleges/collegeRouter.js";
import departmentRouter from "./src/modules/departments/departmentRouter.js";
import settingsRouter from "./src/modules/settings/settingsRouter.js";
import locationRouter from "./src/modules/locations/locationRouter.js";
import courseCatalogRouter from "./src/modules/courseCatalog/courseCatalogRouter.js";
import courseOfferingRouter from "./src/modules/courseOfferings/courseOfferingRouter.js";
import enrollmentRouter from "./src/modules/enrollments/enrollmentRouter.js";

// Load env vars
dotenv.config();

// Validate essential environment variables
const requiredEnvVars = [
    "PORT",
    "DB_CONNECTION",
    "JWT_SECRET",
    "ENCRYPTION_KEY",
    "HASH_SECRET",
    "EMAIL_HOST",
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
    console.error("################################################");
    console.error("💥 FATAL ERROR: Missing Environment Variables:");
    missingEnvVars.forEach((key) => console.error(`   - ${key}`));
    console.error("################################################");
    process.exit(1);
}

const app = express();

// ===========================================
// 1) GLOBAL CONFIGURATION & SECURITY
// ===========================================

// Prevent server overload
app.use(function (req, res, next) {
    if (toobusy()) {
        // 503 Service Unavailable
        return res.status(503).json({
            status: "error",
            message: "Server is too busy right now, please try again later.",
        });
    }
    next();
});

// Trust proxy
app.enable("trust proxy");

// Enable CORS – allow frontend origin (localhost in dev, FRONTEND_URL in prod)
const allowedOrigins = [
    "https://frontwebapp-fshqdheshabmc4dh.westus-01.azurewebsites.net",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:5173",
];
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}
app.use(
    cors({
        origin: (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin))
                return cb(null, true);
            if (process.env.NODE_ENV !== "production") return cb(null, true);
            return cb(null, false);
        },
        credentials: true,
    }),
);

// Secure app by setting headers
app.use(helmet());

//  Development logging
if (process.env.NODE_ENV === "development") {
    app.use(morgan("dev"));
}

// Limit requests from same API (relaxed in development to avoid 429 while testing)
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: process.env.NODE_ENV === "development" ? 500 : 100,
    message:
        "Too many requests from this IP, please try again after 10 minutes",
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
});

// Apply rate limiter to all requests
app.use("/api", limiter);

// ===========================================
// 2) BODY PARSING & SANITIZATION
// ===========================================

app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

// Data sanitization against NoSQL query injection & XSS
app.use(
    sanitizer.clean({
        xss: true,
        noSql: true,
        sql: false,
        whitelist: ["password", "passwordConfirm", "currentPassword"],
    }),
);

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Compress text responses
app.use(compression());

// Parse cookies
app.use(cookieParser());

// ===========================================
// 3) ROUTES & ERROR HANDLING
// ===========================================

// API info routes (no auth, for health/debug)
const apiInfoRouter = express.Router();
apiInfoRouter.get("/test", (req, res) => {
    res.status(200).json({ message: "Backend working" });
});
apiInfoRouter.get("/db-info", (req, res) => {
    const db = mongoose.connection?.db;
    res.status(200).json({
        connected: mongoose.connection.readyState === 1,
        databaseName: db?.databaseName ?? null,
        host: mongoose.connection?.host ?? null,
    });
});
app.use("/api", apiInfoRouter);

// Test router (v1)
app.get("/api/v1/test", (req, res) => {
    res.status(200).json({
        status: "success",
        message: "Test route",
    });
});

// Health Check Route (For Azure/AWS Load Balancers) – includes DB info
app.get("/health", (req, res) => {
    const db = mongoose.connection?.db;
    res.status(200).json({
        status: "UP",
        timestamp: new Date(),
        uptime: process.uptime(),
        database: {
            connected: mongoose.connection.readyState === 1,
            name: db?.databaseName ?? null,
            host: mongoose.connection?.host ?? null,
        },
    });
});

app.use("/api/v1/users", userRouter);
app.use("/api/v1/auth", authRouter);

// Phase 1 — Organizational Core
app.use("/api/v1/colleges", collegeRouter);
app.use("/api/v1/departments", departmentRouter);
app.use("/api/v1/settings", settingsRouter);
app.use("/api/v1/locations", locationRouter);

// Phase 3 — Academic Core & Enrollment Engine
app.use("/api/v1/course-catalog", courseCatalogRouter);
app.use("/api/v1/course-offerings", courseOfferingRouter);
app.use("/api/v1/enrollments", enrollmentRouter);

// Handle Unhandled Routes
app.all(/(.*)/, (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global Error Handler
app.use(globalErrorHandler);

export default app;
