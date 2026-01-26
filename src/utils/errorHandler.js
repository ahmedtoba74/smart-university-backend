import AppError from "./appError.js";
import multer from "multer";

/**
 * Handle MongoDB CastError (invalid ID).
 * @function handleCastErrorDB
 * @param {Object} err - The error object.
 * @returns {AppError} Operational error with 400 status.
 */
const handleCastErrorDB = (err) => {
    const message = `Invalid ${err.path}: ${err.value}`;
    return new AppError(message, 400);
};

/**
 * Handle MongoDB Duplicate Fields Error.
 * @function handleDuplicateFieldsDB
 * @param {Object} err - The error object.
 * @returns {AppError} Operational error with 400 status.
 */
const handleDuplicateFieldsDB = (err) => {
    // Extract value from errmsg or keyValue
    const value = err.keyValue ? Object.values(err.keyValue)[0] : err.errmsg.match(/(["'])(\\?.)*?\1/)[0];
    const message = `Duplicate field value: ${value}. Please use another value!`;
    return new AppError(message, 400);
};

/**
 * Handle Mongoose Validation Error.
 * @function handleValidationErrorDB
 * @param {Object} err - The error object.
 * @returns {AppError} Operational error with 400 status.
 */
const handleValidationErrorDB = (err) => {
    const errors = Object.values(err.errors).map((el) => el.message);
    const message = `Invalid input data: ${errors.join(". ")}`;
    return new AppError(message, 400);
};

/**
 * Handle JWT Error (invalid token).
 * @function handleJWTError
 * @returns {AppError} Operational error with 401 status.
 */
const handleJWTError = () =>
    new AppError("Invalid token. Please log in again!", 401);

/**
 * Handle JWT Expired Error.
 * @function handleJWTExpiredError
 * @returns {AppError} Operational error with 401 status.
 */
const handleJWTExpiredError = () =>
    new AppError("Your token has expired! Please log in again.", 401);

/**
 * Handle Multer Error (file upload issues).
 * @function handleMulterError
 * @param {Object} err - The error object.
 * @returns {AppError} Operational error with 400 status.
 */
const handleMulterError = (err) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return new AppError('File is too large! Maximum limit is 50MB.', 400);
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return new AppError('Too many files uploaded or invalid field name.', 400);
    }
    return new AppError(err.message, 400);
};

/**
 * Send detailed error response in development environment.
 * @function sendErrorDev
 * @param {Object} err - The error object.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
const sendErrorDev = (err, req, res) => {
    // API
    if (req.originalUrl.startsWith("/api")) {
        return res.status(err.statusCode).json({
            status: err.status,
            error: err,
            message: err.message,
            stack: err.stack,
        });
    }
};

/**
 * Send limited error response in production environment.
 * @function sendErrorProd
 * @param {Object} err - The error object.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
const sendErrorProd = (err, req, res) => {
    // API
    if (req.originalUrl.startsWith("/api")) {
        // Operational, trusted error: send message to client
        if (err.isOperational) {
            return res.status(err.statusCode).json({
                status: err.status,
                message: err.message,
            });
        }
        // Programming or other unknown error: don't leak details
        console.error("ERROR 💥", err);
        return res.status(500).json({
            status: "error",
            message: "Something went very wrong!",
        });
    }
};

/**
 * Global Error Handling Middleware.
 * @function globalErrorHandler
 * @param {Object} err - The error object.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 */
const globalErrorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || "error";

    if (process.env.NODE_ENV === "development") {
        sendErrorDev(err, req, res);
    } else if (process.env.NODE_ENV === "production") {
        let error = { ...err };
        error.message = err.message;
        error.name = err.name; // Important: copy name explicitly

        if (error.name === "CastError") error = handleCastErrorDB(error);
        if (error.code === 11000) error = handleDuplicateFieldsDB(error);
        if (error.name === "ValidationError") error = handleValidationErrorDB(error);
        if (error.name === "JsonWebTokenError") error = handleJWTError();
        if (error.name === "TokenExpiredError") error = handleJWTExpiredError();
        if (error.name === "MulterError") error = handleMulterError(error);

        sendErrorProd(error, req, res);
    }
};

export default globalErrorHandler;
