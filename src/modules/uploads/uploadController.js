// uploadController.js
import { uploadToCloudinary } from "../../utils/uploadHelper.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";

export const uploadGeneralFile = catchAsync(async (req, res, next) => {
    const file = req.files?.file?.[0] || req.file;
    if (!file) return next(new AppError("No file uploaded.", 400));

    // 'general' is the fallback folder, or you can pass a query param ?folder=assessments
    const folder = req.query.folder || "general";
    const result = await uploadToCloudinary(file.buffer, folder);

    res.status(200).json({
        status: "success",
        data: {
            fileName: file.originalname,
            fileUrl: result.secure_url,
            fileType: file.mimetype,
        },
    });
});
