import { promisify } from "util";
import jwt from "jsonwebtoken";
import User from "../../DB/models/userModel.js";

/**
 * Socket.io authentication middleware.
 * Mirrors protect() from authMiddleware.js with the same 6 security checks,
 * adapted for the Socket.io handshake signature (socket, next).
 *
 * Guards applied in order:
 *   1. requiresPasswordChange  — blocks temp-password users from connecting
 *   2. lastLoginAt             — single-session guard
 *   3. changedPasswordAfter    — password rotation guard
 *   4. tokensInvalidatedAt     — admin force-logout guard
 *
 * The userModel pre-find hook implicitly rejects inactive users (active: false)
 * because User.findById goes through the pre-find middleware chain.
 */
export const socketProtect = async (socket, next) => {
    try {
        let token;

        if (socket.handshake.auth && socket.handshake.auth.token) {
            token = socket.handshake.auth.token;
        } else if (socket.handshake.query && socket.handshake.query.token) {
            token = socket.handshake.query.token;
        }

        if (!token) {
            return next(new Error("Authentication error: Token not provided."));
        }

        const decoded = await promisify(jwt.verify)(
            token,
            process.env.JWT_SECRET,
        );

        // Inactive users (active: false) return null via userModel pre-find hook
        const currentUser = await User.findById(decoded.id);
        if (!currentUser) {
            return next(
                new Error("Authentication error: User no longer exists."),
            );
        }

        // Guard 1: Temporary password — must change via HTTP before connecting
        if (currentUser.requiresPasswordChange) {
            return next(
                new Error(
                    "Authentication error: You must change your temporary password before connecting.",
                ),
            );
        }

        // Guard 2: Single-session — newer login invalidates older tokens
        if (currentUser.lastLoginAt) {
            const lastLoginTimestamp = parseInt(
                currentUser.lastLoginAt.getTime() / 1000,
                10,
            );
            if (lastLoginTimestamp > decoded.iat) {
                return next(
                    new Error(
                        "Authentication error: Session invalidated by newer login.",
                    ),
                );
            }
        }

        // Guard 3: Password rotation — token issued before password change is invalid
        if (currentUser.changedPasswordAfter(decoded.iat)) {
            return next(
                new Error(
                    "Authentication error: Password recently changed. Please re-authenticate.",
                ),
            );
        }

        // Guard 4: Admin force-logout via tokensInvalidatedAt timestamp
        // Using <= (not <) — cryptographically safe, handles clock drift natively
        if (currentUser.tokensInvalidatedAt) {
            const invalidationTimestamp = parseInt(
                currentUser.tokensInvalidatedAt.getTime() / 1000,
                10,
            );
            if (decoded.iat <= invalidationTimestamp) {
                return next(
                    new Error(
                        "Authentication error: Token invalidated by system.",
                    ),
                );
            }
        }

        socket.user = currentUser;
        next();
    } catch (err) {
        return next(
            new Error("Authentication error: Invalid or expired token."),
        );
    }
};
