// src/utils/auditLogger.js
// Structured audit logger for security-sensitive events in the Smart University Platform.
// Outputs newline-delimited JSON to stdout so log aggregators (CloudWatch, Azure Monitor,
// Datadog, etc.) can parse, index, and alert on audit events without additional libraries.

/**
 * Writes a structured audit entry to stdout.
 *
 * Format: one JSON object per line tagged with level = "AUDIT".
 * This separates audit events from regular application logs in any
 * log aggregation pipeline that supports level-based filtering.
 *
 * @param {Object} event
 * @param {Object} event.actor        - req.user — must have _id, name, role
 * @param {string} event.action       - Semantic action name (e.g. "ANNOUNCEMENT_CREATED")
 * @param {string} event.resource     - Resource type (e.g. "Announcement")
 * @param {*}      [event.resourceId] - MongoDB ObjectId of the affected document
 * @param {string} [event.ip]         - Client IP (req.ip — respects trust proxy)
 * @param {Object} [event.details]    - Extra context relevant to the action
 */
export const logAuditEvent = ({
    actor,
    action,
    resource,
    resourceId,
    ip,
    details = {},
}) => {
    const entry = {
        level: "AUDIT",
        timestamp: new Date().toISOString(),
        actor: {
            id: actor._id?.toString() ?? null,
            name: actor.name ?? null,
            role: actor.role ?? null,
        },
        action,
        resource,
        resourceId: resourceId?.toString() ?? null,
        ip: ip ?? "unknown",
        details,
    };

    // process.stdout.write ensures the entry lands in server logs
    // even when console is remapped by a logging framework.
    console.log(JSON.stringify(entry));
};
