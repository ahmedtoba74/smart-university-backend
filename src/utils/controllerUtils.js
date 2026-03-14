import AppError from './appError.js';

// ============================================
// SHARED CONTROLLER UTILITIES
// ============================================

/**
 * Protected fields that can never be selected via ?fields query param.
 * Even though these fields have `select: false` in the model, we block them
 * proactively to prevent information about their existence leaking.
 */
const PROTECTED_FIELDS = [
    'password', 'tempPassword', 'nationalID', 'nationalIDHash',
    'passwordResetToken', 'passwordResetExpires', 'twoFAToken', 'twoFATokenExpires'
];

/**
 * Validates and normalizes the `?isArchived` query parameter.
 *
 * Security: prevents NoSQL injection via ?isArchived[$ne]=true.
 * Access:   non-admin roles always see active items only.
 * Values:   'true' → archived only | 'false' → active only | 'all' → both
 *
 * Returns false and calls next(error) if invalid.
 * Returns true if the guard passes (caller should continue).
 *
 * @param {Object} req   - Express request object
 * @param {Function} next - Express next function
 * @returns {boolean}
 */
export const applyIsArchivedGuard = (req, next) => {
    const VALID_VALUES = ['true', 'false', 'all'];
    const raw = req.query.isArchived;

    if (raw === undefined) return true; // no param — pre-hook handles the default

    // Reject objects: ?isArchived[$ne]=true arrives as an object, not a string
    if (typeof raw !== 'string' || !VALID_VALUES.includes(raw)) {
        next(new AppError('Invalid value for isArchived. Allowed: true, false, all.', 400));
        return false;
    }

    const isAdminRole = ['universityAdmin', 'collegeAdmin'].includes(req.user.role);

    if (!isAdminRole) {
        // Non-admins always see active items — strip the param entirely
        delete req.query.isArchived;
    } else if (raw === 'all') {
        // Replace 'all' with a MongoDB $in expression to bypass the pre-hook
        req.query.isArchived = { $in: [true, false] };
    }
    // 'true' or 'false' are passed as-is — apiFeatures.filter() handles them,
    // and the pre-hook detects that isArchived is defined and skips its default.

    return true;
};

/**
 * Blocks attempts to select sensitive fields via ?fields query param.
 *
 * Security: even though protected fields have `select: false` in the model,
 * this defense-in-depth check prevents probing for field existence.
 *
 * Returns false and calls next(error) if blocked.
 * Returns true if the guard passes.
 *
 * @param {Object} req   - Express request object
 * @param {Function} next - Express next function
 * @returns {boolean}
 */
export const applyFieldsGuard = (req, next) => {
    if (!req.query.fields) return true;

    const requested = req.query.fields.split(',').map(f => f.trim());
    const blocked = requested.filter(f => PROTECTED_FIELDS.includes(f));

    if (blocked.length > 0) {
        next(new AppError(`Access to protected fields is not allowed: ${blocked.join(', ')}.`, 403));
        return false;
    }

    return true;
};

/**
 * Builds a filtered request body from an explicit whitelist.
 *
 * Security: Whitelist approach — only explicitly allowed fields are
 * passed to the database. Prevents mass-assignment of sensitive fields
 * like isArchived, college_id, role, etc.
 *
 * @param {Object} body          - req.body
 * @param {string[]} allowedFields - array of field names to permit
 * @returns {Object} filteredBody — only contains keys in allowedFields
 */
export const filterReqBody = (body, allowedFields) => {
    const filteredBody = {};
    allowedFields.forEach(field => {
        if (body[field] !== undefined) {
            filteredBody[field] = body[field];
        }
    });
    return filteredBody;
};

/**
 * Builds the ownership-aware filter for scoped write operations (PATCH, archive).
 *
 * Security: Bakes the ownership check directly into the DB query (TOCTOU fix).
 * If a collegeAdmin passes a resource ID from another college, MongoDB returns
 * null — the controller returns 404, preventing info leakage.
 *
 * @param {string} id      - req.params.id
 * @param {Object} user    - req.user
 * @param {string} scopeField - the field to scope by (default: 'college_id')
 * @returns {Object} MongoDB filter
 */
export const buildOwnershipFilter = (id, user, scopeField = 'college_id') => {
    const filter = { _id: id };
    if (user.role === 'collegeAdmin') {
        filter[scopeField] = user.college_id;
    }
    return filter;
};
