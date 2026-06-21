/**
 * ===================================================================================
 * @file      chatTools.js
 * @desc      Role-scoped tool registry aggregator.
 *            Exports a single function, getToolsForRole(), which selects the
 *            appropriate category modules for the given role and returns a flat
 *            array of LangChain DynamicStructuredTool instances with userContext
 *            bound to each tool's execute function.
 *
 *            Category loading order:
 *              Tier 1 (all roles):           profileTools, announcementTools, ragTools*
 *              Tier 2 (student):             + academicTools, attendanceTools
 *              Tier 3 (doctor / ta):         + attendanceTools, gradebookTools
 *              Tier 4 (collegeAdmin):        + administrationTools
 *              Tier 5 (universityAdmin):     + systemTools
 *
 *            *ragTools is conditionally included based on conversation.hasRagContext.
 *             Pass hasRagContext: true in the userContext options to enable it.
 *
 *            Security invariant:
 *              userContext ({ user, scopeFilter, conversationId }) is always injected
 *              server-side. Tools NEVER accept role, college_id, or user identity
 *              from the LLM's input parameters — only from userContext.
 *
 *            Scalability:
 *              - Adding a new tool: add it to the appropriate category file only.
 *              - Adding a new category: create a new file, add one push() here.
 *              - Neither change affects existing categories or their tests.
 *
 * @module    src/tools/chatTools
 * @requires  @langchain/core/tools
 * @requires  ./registry/profileTools
 * @requires  ./registry/announcementTools
 * @requires  ./registry/ragTools
 * @requires  ./registry/academicTools
 * @requires  ./registry/attendanceTools
 * @requires  ./registry/gradebookTools
 * @requires  ./registry/administrationTools
 * @requires  ./registry/systemTools
 * ===================================================================================
 */

import { DynamicStructuredTool } from "@langchain/core/tools";

import profileTools from "./registry/profileTools.js";
import announcementTools from "./registry/announcementTools.js";
import ragTools from "./registry/ragTools.js";
import academicTools from "./registry/academicTools.js";
import attendanceTools from "./registry/attendanceTools.js";
import gradebookTools from "./registry/gradebookTools.js";
import administrationTools from "./registry/administrationTools.js";
import systemTools from "./registry/systemTools.js";

// ===================================================================================
// TOOL LABEL MAP
// ===================================================================================

/**
 * Maps tool names to their human-readable labels.
 * Used by the stream controller to produce the toolsInvoked display list.
 * Generated from all category modules to stay in sync automatically.
 *
 * @type {Object.<string, string>}
 */
export const toolLabelMap = Object.fromEntries(
    [
        ...profileTools,
        ...announcementTools,
        ...ragTools,
        ...academicTools,
        ...attendanceTools,
        ...gradebookTools,
        ...administrationTools,
        ...systemTools,
    ].map((tool) => [tool.name, tool.label]),
);

// ===================================================================================
// AGGREGATOR
// ===================================================================================

/**
 * Returns a flat array of LangChain DynamicStructuredTool instances scoped to
 * the given role and bound to the provided userContext.
 *
 * @param {string} role - The authenticated user's role.
 *                        One of: student, doctor, ta, collegeAdmin, universityAdmin.
 * @param {Object} userContext - Injected server-side context for all tools.
 * @param {Object} userContext.user - The full User document from protect middleware.
 * @param {Object} userContext.scopeFilter - Tenant scope filter from attachCollegeScope.
 * @param {ObjectId|null} [userContext.conversationId] - Current conversation ID.
 *                        Required for ragTools vector search.
 * @param {boolean} [userContext.hasRagContext=false] - Whether to include ragTools.
 *                  Set to true only when conversation.hasRagContext === true.
 * @returns {DynamicStructuredTool[]} Array of LangChain tool instances.
 */
export function getToolsForRole(role, userContext) {
    const categories = [];

    // ── Tier 1: All authenticated users ──────────────────────────────────────────
    categories.push(...profileTools);
    categories.push(...announcementTools);

    // RAG tool is conditionally loaded based on whether the conversation has
    // uploaded document context. Passing hasRagContext: false omits it entirely
    // to avoid the LLM calling a tool that would return empty results.
    if (userContext.hasRagContext) {
        categories.push(...ragTools);
    }

    // ── Tier 2: Student ───────────────────────────────────────────────────────────
    if (role === "student") {
        categories.push(...academicTools);
        categories.push(...attendanceTools);
    }

    // ── Tier 3: Doctor / TA ───────────────────────────────────────────────────────
    if (role === "doctor" || role === "ta") {
        categories.push(...attendanceTools);
        categories.push(...gradebookTools);
    }

    // ── Tier 4: College Admin ─────────────────────────────────────────────────────
    if (role === "collegeAdmin") {
        categories.push(...administrationTools);
    }

    // ── Tier 5: University Admin ──────────────────────────────────────────────────
    if (role === "universityAdmin") {
        categories.push(...systemTools);
    }

    // ── Wrap each tool definition as a LangChain DynamicStructuredTool ───────────
    return categories.map(
        (tool) =>
            new DynamicStructuredTool({
                name: tool.name,
                description: tool.description,
                schema: tool.schema,
                func: (input) => tool.execute(input, userContext),
            }),
    );
}
