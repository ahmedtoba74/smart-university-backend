// src/utils/announcementUtils.js
// Scheduled maintenance utilities for the Announcements module.
// Called by the server's maintenance intervals (server.js).

import Announcement from "../../DB/models/announcementModel.js";

/**
 * Soft-deletes all active announcements whose `expiresAt` timestamp has passed.
 * Uses `updateMany` which bypasses the pre-find query hook intentionally —
 * this IS the cleanup mechanism; it targets documents not yet archived.
 *
 * This function is designed to be called periodically (e.g. every hour) from
 * server.js. It mirrors the `expireDueSessions` pattern from attendanceUtils.js.
 *
 * Safety: only targets documents where:
 *   - expiresAt is not null ($ne null)
 *   - expiresAt is in the past ($lte now)
 *   - isArchived is still false (not already soft-deleted)
 */
export const expireAnnouncements = async () => {
    const result = await Announcement.updateMany(
        {
            expiresAt: { $ne: null, $lte: new Date() },
            isArchived: false,
        },
        { isArchived: true },
    );

    if (result.modifiedCount > 0) {
        console.log(
            `[AnnouncementCleanup] Soft-deleted ${result.modifiedCount} expired announcement(s) at ${new Date().toISOString()}.`,
        );
    }
};
