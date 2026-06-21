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
import { allowedOrigins, corsOriginHandler } from "./src/config/corsConfig.js";

import userRouter from "./src/modules/users/userRouter.js";
import authRouter from "./src/modules/auth/authRouter.js";
import collegeRouter from "./src/modules/colleges/collegeRouter.js";
import departmentRouter from "./src/modules/departments/departmentRouter.js";
import settingsRouter from "./src/modules/settings/settingsRouter.js";
import locationRouter from "./src/modules/locations/locationRouter.js";
import courseCatalogRouter from "./src/modules/courseCatalog/courseCatalogRouter.js";
import courseOfferingRouter from "./src/modules/courseOfferings/courseOfferingRouter.js";
import enrollmentRouter from "./src/modules/enrollments/enrollmentRouter.js";
import submissionRouter from "./src/modules/submissions/submissionRouter.js";
import gradebookRouter from "./src/modules/gradebooks/gradebookRouter.js";
import uploadRouter from "./src/modules/uploads/uploadRouter.js";
// Phase 5 — Fingerprint Attendance (GAP-5)
import attendanceRouter from "./src/modules/attendance/attendanceRouter.js";
// Phase 6 — Announcements & Real-Time Notifications Engine
import announcementRouter from "./src/modules/announcements/announcementRouter.js";

// Load env vars
dotenv.config();

// Validate essential environment variables
const requiredEnvVars = [
    "PORT",
    "JWT_SECRET",
    "ENCRYPTION_KEY",
    "HASH_SECRET",
    "EMAIL_HOST",
    // Phase 5 — IoT device shared secret is required at startup (BE-CRIT-4).
    // IOT_HUB_CONNECTION_STRING is intentionally NOT here — optional when IOT_MOCK_MODE=true.
    "IOT_DEVICE_SECRET",
    // Phase 7 — Azure OpenAI (fail fast — no runtime fallback)
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

// Database connection requires either MONGO_URI or DB_CONNECTION
if (!process.env.DB_CONNECTION && !process.env.MONGO_URI) {
    missingEnvVars.push("DB_CONNECTION (or MONGO_URI)");
}

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
// corsOriginHandler is imported from src/config/corsConfig.js — single source of truth
// shared with the Socket.io server (socketService.js).
app.use(
    cors({
        origin: corsOriginHandler,
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
    // CRIT-2: Exempt IoT device endpoints from rate limiting.
    // IMPORTANT: Use req.originalUrl — NOT req.path.
    // When mounted at '/api', req.path becomes relative (e.g. '/v1/attendance/fingerprint-mark')
    // and never matches the full path. req.originalUrl always contains the full original URL.
    skip: (req) => {
        const iotPaths = [
            "/api/v1/attendance/fingerprint-mark",
            "/api/v1/attendance/fingerprints/register",
            "/api/v1/attendance/devices/heartbeat",
        ];
        // Existing IoT exemption (unchanged)
        if (iotPaths.some((p) => req.originalUrl.startsWith(p))) return true;
        // Phase 7 — Exempt SSE stream from rate limiter.
        // Token budget system already prevents abuse. Long-lived SSE connections
        // would exhaust the 100-req/10min limit for legitimate chat users.
        if (
            req.originalUrl.match(
                /\/api\/v1\/chat\/conversations\/[^/]+\/stream$/,
            )
        ) {
            return true;
        }
        return false;
    },
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
        // CRIT-1: 'templateData' is whitelisted because fingerprint templates are base64-encoded.
        // Base64 chars (+, /, =) trigger XSS sanitization rules and silently corrupt binary data.
        whitelist: [
            "password",
            "passwordConfirm",
            "currentPassword",
            "templateData",
            "content", // Phase 7 — Chat message content must not be XSS-sanitized server-side
        ],
    }),
);

// Prevent HTTP Parameter Pollution
app.use(hpp());

// GAP-6 (Phase 7): Filter SSE responses from compression.
// SSE streams require unbuffered chunked output — gzip buffering breaks real-time
// token-by-token delivery. All other REST API responses continue to be compressed.
app.use(
    compression({
        filter: (req, res) => {
            if (res.getHeader("Content-Type") === "text/event-stream") {
                return false;
            }
            return compression.filter(req, res);
        },
    }),
);

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

// Phase 4 — LMS Core, Gradebook, & Decoupled Media Uploads
app.use("/api/v1/submissions", submissionRouter);
app.use("/api/v1/gradebook", gradebookRouter);
app.use("/api/v1/uploads", uploadRouter);

// Phase 5 — Fingerprint Attendance System (GAP-5)
app.use("/api/v1/attendance", attendanceRouter);

// Phase 6 — Announcements & Real-Time Notifications Engine
app.use("/api/v1/announcements", announcementRouter);

// Phase 7 — AI Chatbot Engine
// chatRouter import and mount added in Step 15 after chatRouter.js is created.
// app.use("/api/v1/chat", chatRouter);

// Handle Unhandled Routes — MUST REMAIN LAST
app.all(/(.*)/, (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global Error Handler
app.use(globalErrorHandler);

export default app;
