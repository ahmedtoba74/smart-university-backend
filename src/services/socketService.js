/**
 * ===================================================================================
 * @file      socketService.js
 * @desc      Socket.io service for handling real-time notifications and device heartbeats.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Services/Socket
 */

// src/services/socketService.js
// Real-time WebSocket engine for the Smart University Platform.
// Implements room-based subscriptions and fire-and-forget announcement broadcasts.

import { Server } from "socket.io";
import { socketProtect } from "../middlewares/socketMiddleware.js";
import { corsOriginHandler } from "../config/corsConfig.js";
import Enrollment from "../../DB/models/enrollmentModel.js";
import CourseOffering from "../../DB/models/courseOfferingModel.js";
import Department from "../../DB/models/departmentModel.js";
import User from "../../DB/models/userModel.js";

let io = null;

// ===========================================
// INITIALIZATION
// ===========================================

export const initSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            // Shared handler: warns on blocked origins in production instead of silent drop.
            // Defined in src/config/corsConfig.js — single source of truth with app.js.
            origin: corsOriginHandler,
            credentials: true,
        },
    });

    // Apply JWT auth middleware to every incoming connection
    io.use(socketProtect);

    io.on("connection", async (socket) => {
        const user = socket.user;

        try {
            // --- ROOM SUBSCRIPTIONS ---

            // 1. Every authenticated user joins the global room
            socket.join("global");

            // 2. Join college room if user has a college
            if (user.college_id) {
                socket.join(`college:${user.college_id.toString()}`);
            }

            // 3. Join department room if user has a department
            if (user.department_id) {
                socket.join(`dept:${user.department_id.toString()}`);
            }

            // 4. Role-specific course room subscriptions
            if (user.role === "student") {
                // Students join rooms for their currently active enrollments only.
                // Historical enrollments (passed/failed) are excluded from sockets —
                // sockets are for live delivery. REST GET includes historical data.
                const enrollments = await Enrollment.find({
                    student_id: user._id,
                    status: "enrolled",
                })
                    .select("course_id")
                    .lean();

                enrollments.forEach((e) => {
                    socket.join(`course:${e.course_id.toString()}`);
                });
            } else if (user.role === "doctor" || user.role === "ta") {
                // Intentionally excludes archived CourseOfferings (pre-find hook default).
                // Archived courses do not generate new announcements.
                // Sockets are for real-time delivery only.
                // REST GET uses isArchived: { $in: [true, false] } for historical data.
                const offerings = await CourseOffering.find({
                    $or: [{ doctors_ids: user._id }, { tas_ids: user._id }],
                })
                    .select("_id")
                    .lean();

                offerings.forEach((o) => {
                    socket.join(`course:${o._id.toString()}`);
                });
            } else if (user.role === "collegeAdmin") {
                // Hard stop: without a college_id the queries below become unconstrained
                // (college_id: undefined matches all documents), causing this socket to
                // subscribe to every department and course room system-wide.
                // This is a data-integrity requirement, not just a validation nicety.
                if (!user.college_id) {
                    throw new Error(
                        `collegeAdmin ${user._id} is missing college_id — room subscription aborted to prevent over-subscription.`,
                    );
                }

                // CollegeAdmin joins all department rooms in their college
                const depts = await Department.find({
                    college_id: user.college_id,
                })
                    .select("_id")
                    .lean();

                depts.forEach((d) => {
                    socket.join(`dept:${d._id.toString()}`);
                });

                // CollegeAdmin joins all active course offering rooms in their college
                // (pre-find hook excludes archived — intentional for live delivery)
                const offerings = await CourseOffering.find({
                    college_id: user.college_id,
                })
                    .select("_id")
                    .lean();

                offerings.forEach((o) => {
                    socket.join(`course:${o._id.toString()}`);
                });
            }

            if (process.env.NODE_ENV === "development") {
                console.log(
                    `[WS] Connected: ${user.name} (${user.role}) joined ${socket.rooms.size} rooms.`,
                );
            }
        } catch (err) {
            console.error(
                `[WS] Room subscription error for user ${user._id}:`,
                err.message,
            );
            // Inform client but do not disconnect — they remain in the global room
            socket.emit("subscription_error", {
                message:
                    "Failed to join all rooms. Some notifications may be missed.",
            });
        }
    });

    return io;
};

// ===========================================
// IO INSTANCE ACCESSOR
// ===========================================

export const getIO = () => {
    return io;
};

// ===========================================
// FIRE-AND-FORGET BROADCAST HELPER
// ===========================================

/**
 * Emits a new_announcement event to all relevant Socket.io rooms.
 *
 * Design decisions:
 * - async: fetches author profile separately to avoid mutating the caller's Mongoose document.
 * - Called without await in the controller with .catch() to absorb async rejections.
 * - authorData null-guarded: handles the edge case where the author is deactivated
 *   between announcement creation and broadcast execution.
 * - CORS silent rejection used (cb(null, false)) to prevent log pollution.
 */
export const broadcastAnnouncement = async (announcement) => {
    const ioInstance = getIO();
    if (!ioInstance) return;

    // Fetch author data via separate lean query — does NOT mutate the announcement document
    const authorData = await User.findById(announcement.author_id)
        .select("name role")
        .lean();

    // Defensive fallback: author may be deactivated by the time broadcast runs
    const author = authorData ?? { name: "Unknown", role: "unknown" };

    const level = announcement.scope.level;
    const targets = announcement.scope.target || [];

    // Map scope to Socket.io room strings
    let rooms = [];
    if (level === "Global") {
        rooms = ["global"];
    } else if (level === "College") {
        rooms = targets.map((id) => `college:${id.toString()}`);
    } else if (level === "Department") {
        rooms = targets.map((id) => `dept:${id.toString()}`);
    } else if (level === "Course") {
        rooms = targets.map((id) => `course:${id.toString()}`);
    }

    if (rooms.length > 0) {
        ioInstance.to(rooms).emit("new_announcement", {
            id: announcement._id,
            title: announcement.title,
            content: announcement.content,
            scope: announcement.scope,
            createdAt: announcement.createdAt,
            author,
        });
    }
};
