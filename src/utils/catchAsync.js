/**
 * ===================================================================================
 * @file      catchAsync.js
 * @desc      Express async error wrapper to avoid try-catch blocks in route controllers.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/CatchAsync
 */

/**
 * Middleware wrapper to catch asynchronous errors and pass them to the global error handler.
 * @function catchAsync
 * @param {Function} fn - Asynchronous function to wrap.
 * @returns {Function} Express middleware function.
 */
const catchAsync = (fn) => {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
};

export default catchAsync;
