import cloudinary from "./cloudinary.js";
import { nanoid } from "nanoid";

export const uploadToCloudinary = (fileBuffer, folder = "general", isRaw = false) => {
    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `smart-university/${folder}`,
            public_id: nanoid(),
            resource_type: isRaw ? "raw" : "auto",
        };

        if (!isRaw) {
            uploadOptions.transformation = [{ quality: "auto" }, { fetch_format: "auto" }];
        }

        const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            },
        );
        uploadStream.end(fileBuffer);
    });
};

/**
 * Extract public_id from Cloudinary URL and delete the file
 * @param {string} fileUrl - The full Cloudinary URL stored in DB
 * @returns {Promise}
 */
export const deleteFromCloudinary = (fileUrl) => {
    return new Promise((resolve, reject) => {
        try {
            const parts = fileUrl.split("/");
            const uploadIndex = parts.findIndex((part) => part === "upload");

            if (uploadIndex === -1) return resolve(true);

            let publicId = parts.slice(uploadIndex + 2).join("/");

            const lastDotIndex = publicId.lastIndexOf(".");
            if (lastDotIndex !== -1) {
                publicId = publicId.substring(0, lastDotIndex);
            }

            cloudinary.uploader.destroy(publicId, (error, result) => {
                if (error) return reject(error);
                resolve(result);
            });
        } catch (err) {
            console.error("Cloudinary Deletion Error:", err);
            resolve(false);
        }
    });
};
