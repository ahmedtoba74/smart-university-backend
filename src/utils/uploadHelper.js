import cloudinary from './cloudinary.js';
import { nanoid } from 'nanoid'; 

export const uploadToCloudinary = (fileBuffer, folder = 'general') => {
    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `smart-university/${folder}`,
            public_id: nanoid(), 
            resource_type: "auto", 
            
            transformation: [
                { quality: "auto" }, 
                { fetch_format: "auto" } 
            ]
        };

        const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        uploadStream.end(fileBuffer);
    });
};