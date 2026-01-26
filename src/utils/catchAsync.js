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
