import multer from 'multer';
import AppError from '../utils/appError.js';

export const uploadMix = (arrayOfFields, fileType) => {
    
    // 1. Storage Configuration (Memory)
    const storage = multer.memoryStorage();

    // 2. File Filter (Validation)
    const fileFilter = (req, file, cb) => {
        if (fileType.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new AppError('Invalid file type! Please upload only allowed formats.', 400), false);
        }
    };

    const upload = multer({ 
        storage, 
        fileFilter,
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB Max Size
    });

    // 3. Return fields (Support Single, Multiple, Mixed)

    return upload.fields(arrayOfFields);
};