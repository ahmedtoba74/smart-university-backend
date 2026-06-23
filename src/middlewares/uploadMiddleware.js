/**
 * ===================================================================================
 * @file      uploadMiddleware.js
 * @desc      Middleware for handling file uploads (Multer configurations).
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Middlewares/Upload
 */

import multer from "multer";
import AppError from "../utils/appError.js";

export const uploadMix = (arrayOfFields, fileType) => {
    // 1. Storage Configuration (Memory)
    const storage = multer.memoryStorage();

    // 2. File Filter (Validation)
    const fileFilter = (req, file, cb) => {
        if (fileType.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(
                new AppError(
                    "Invalid file type! Please upload only allowed formats.",
                    400,
                ),
                false,
            );
        }
    };

    const upload = multer({
        storage,
        fileFilter,
        limits: { fileSize: 50 * 1024 * 1024 }, // 50MB Max Size
    });

    // 3. Return fields (Support Single, Multiple, Mixed)

    return (req, res, next) => {
        upload.fields(arrayOfFields)(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                    return next(
                        new AppError(
                            "File is too large! Maximum limit is 50MB.",
                            400,
                        ),
                    );
                }
                if (err.code === "LIMIT_UNEXPECTED_FILE") {
                    return next(
                        new AppError(
                            "Too many files uploaded or invalid field name.",
                            400,
                        ),
                    );
                }
                if (err.code === "MISSING_FIELD_NAME") {
                    return next(
                        new AppError(
                            "Field name missing in form-data. Please ensure all uploaded files have a valid 'name' field.",
                            400,
                        ),
                    );
                }
                return next(new AppError(err.message, 400));
            } else if (err) {
                return next(err);
            }
            next();
        });
    };
};
