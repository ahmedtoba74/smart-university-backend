/**
 * ===================================================================================
 * @file      cloudinary.js
 * @desc      Cloudinary integration for uploading and deleting media assets.
 * @author    Ahmed Toba
 * @version   1.0.0
 * ===================================================================================
 * @module    Utils/Cloudinary
 */

import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default cloudinary;
