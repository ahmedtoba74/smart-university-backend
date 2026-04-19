/**
 * ===================================================================================
 * @file      materialController.js
 * @desc      Controller for course material management (CRUD operations).
 *            Handles file uploads, external links, and ownership-based permissions.
 * @module    modules/material/materialController
 * @requires  Material, CourseOffering models, catchAsync, AppError
 * ===================================================================================
 */

import Material from "../../../DB/models/materialModel.js";
import CourseOffering from "../../../DB/models/courseOfferingModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import {
    uploadToCloudinary,
    deleteFromCloudinary,
} from "../../utils/uploadHelper.js";

/**
 * Create a new material (file upload or external link)
 *
 * Business Logic:
 * 1. Verify course offering exists and belongs to user's college (IDOR protection)
 * 2. Denormalize college_id from course offering
 * 3. Set uploadedBy_id to current user
 * 4. Create material document
 *
 * @route   POST /api/v1/offerings/:offeringId/materials
 * @access  Doctors & TAs (assigned to course via attachStaffScope)
 * @body    { title, description, category, isExternalLink, url, fileName?, fileType? }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.body - Material data
 * @param   {Object} req.user - Authenticated user (from protect middleware)
 * @param   {Object} req.scopeFilter - Tenant filter (from attachCollegeScope)
 *
 * @returns {Object} 201 - { status: 'success', data: { material } }
 * @throws  {AppError} 404 - Course offering not found
 */

export const createMaterial = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    let { title, description, category, isExternalLink, url } = req.body;

    isExternalLink = isExternalLink === "true" || isExternalLink === true;

    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    let finalUrl = url;
    let finalFileName = null;
    let finalFileType = null;

    if (isExternalLink) {
        if (!url)
            return next(
                new AppError("URL is required for external links.", 400),
            );
        if (category !== "Links")
            return next(
                new AppError(
                    "Category must be 'Links' for external materials.",
                    400,
                ),
            );
    } else {
        const file = req.files?.file?.[0];
        if (!file)
            return next(
                new AppError("A file is required for non-link materials.", 400),
            );
        if (!["Lectures", "Sheets", "Readings"].includes(category)) {
            return next(
                new AppError(
                    "Category must be 'Lectures', 'Sheets', or 'Readings'.",
                    400,
                ),
            );
        }

        const isRaw =
            !file.mimetype.startsWith("image/") &&
            !file.mimetype.startsWith("video/");
        const cloudinaryResult = await uploadToCloudinary(
            file.buffer,
            `materials/${offeringId}`,
            isRaw,
        );

        finalUrl = cloudinaryResult.secure_url;
        finalFileName = file.originalname;
        finalFileType = file.mimetype;
    }

    const material = await Material.create({
        title,
        description,
        courseOffering_id: offeringId,
        college_id: offering.college_id,
        category,
        isExternalLink,
        url: finalUrl,
        fileName: finalFileName,
        fileType: finalFileType,
        uploadedBy_id: req.user._id,
    });

    res.status(201).json({
        status: "success",
        data: { material },
    });
});

/**
 * Get all materials for a course offering
 *
 * Business Logic:
 * 1. Verify course offering exists (IDOR protection)
 * 2. Query materials filtered by offeringId and optional category
 * 3. For students: Additional enrollment check via middleware (future enhancement)
 *
 * @route   GET /api/v1/offerings/:offeringId/materials
 * @access  Doctors, TAs, Students (enrolled), College Admins
 * @query   ?category=Lectures (optional filter)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.query.category - Optional category filter
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', results: n, data: { materials } }
 * @throws  {AppError} 404 - Course offering not found
 */
export const getAllMaterials = catchAsync(async (req, res, next) => {
    const { offeringId } = req.params;
    const { category } = req.query;

    // Step 1: Verify course offering exists
    const offering = await CourseOffering.findOne({
        _id: offeringId,
        ...req.scopeFilter,
    });

    if (!offering) {
        return next(new AppError("Course offering not found.", 404));
    }

    // Step 2: Build query filter
    const filter = {
        courseOffering_id: offeringId,
        college_id: offering.college_id, // Tenant isolation
    };

    // Optional category filter
    if (category) {
        filter.category = category;
    }

    // Step 3: Fetch materials
    const materials = await Material.find(filter)
        .populate("uploadedBy_id", "name email role")
        .sort({ createdAt: -1 }); // Newest first

    res.status(200).json({
        status: "success",
        results: materials.length,
        data: { materials },
    });
});

/**
 * Get a single material by ID
 *
 * Business Logic:
 * 1. Fetch material with tenant isolation
 * 2. Verify material belongs to the specified course offering (URL parameter validation)
 *
 * @route   GET /api/v1/offerings/:offeringId/materials/:id
 * @access  Doctors, TAs, Students (enrolled), College Admins
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Material ID
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { material } }
 * @throws  {AppError} 404 - Material not found
 */
export const getMaterial = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;

    // Fetch material with tenant isolation and offering validation
    const material = await Material.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    }).populate("uploadedBy_id", "name email role");

    if (!material) {
        return next(new AppError("Material not found.", 404));
    }

    res.status(200).json({
        status: "success",
        data: { material },
    });
});

/**
 * Update a material (metadata only - title, description, category)
 *
 * Business Logic:
 * 1. Fetch material with tenant isolation
 * 2. Permission check:
 *    - Doctors: Can edit any material in their course
 *    - TAs: Can only edit their own materials
 * 3. Update allowed fields only (url/file cannot be changed)
 *
 * @route   PATCH /api/v1/offerings/:offeringId/materials/:id
 * @access  Doctors (any material) & TAs (own materials only)
 * @body    { title?, description?, category? }
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Material ID
 * @param   {Object} req.user - Authenticated user
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 200 - { status: 'success', data: { material } }
 * @throws  {AppError} 403 - You can only edit your own materials (TAs)
 * @throws  {AppError} 404 - Material not found
 */
export const updateMaterial = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;
    let { title, description, category, isExternalLink, url } = req.body;

    // Step 1: Fetch material with tenant isolation
    const material = await Material.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!material) {
        return next(new AppError("Material not found.", 404));
    }

    // Step 2: Permission check (TAs can only edit their own materials)
    if (
        req.user.role === "ta" &&
        material.uploadedBy_id.toString() !== req.user._id.toString()
    ) {
        return next(new AppError("You can only edit your own materials.", 403));
    }

    // Step 3: Update allowed metadata fields
    if (title !== undefined) material.title = title;
    if (description !== undefined) material.description = description;
    if (category !== undefined) material.category = category;

    // Step 4: Handle File / URL Replacement
    if (
        isExternalLink !== undefined ||
        req.files?.file?.[0] ||
        url !== undefined
    ) {
        let newIsExternalLink = material.isExternalLink;
        if (isExternalLink !== undefined) {
            newIsExternalLink =
                isExternalLink === "true" || isExternalLink === true;
        }

        if (newIsExternalLink) {
            // Case A: Is/Becomes an External Link
            let newUrl = url;
            if (url === undefined) {
                newUrl = material.isExternalLink ? material.url : undefined;
            }
            if (!newUrl) {
                return next(
                    new AppError("URL is required when switching to an external link.", 400),
                );
            }
            if (material.category !== "Links") {
                return next(
                    new AppError(
                        "Category must be 'Links' for external materials.",
                        400,
                    ),
                );
            }

            // Cleanup old file from Cloudinary if switching from file -> link
            if (!material.isExternalLink && material.url) {
                try {
                    await deleteFromCloudinary(material.url);
                } catch (err) {
                    console.warn(
                        `[WARNING] Failed to delete old file from Cloudinary for material ${id}`,
                    );
                }
            }

            material.isExternalLink = true;
            material.url = newUrl;
            material.fileName = null;
            material.fileType = null;
        } else {
            // Case B: Is/Becomes a File Upload
            if (
                !["Lectures", "Sheets", "Readings"].includes(material.category)
            ) {
                return next(
                    new AppError(
                        "Category must be 'Lectures', 'Sheets', or 'Readings'.",
                        400,
                    ),
                );
            }

            const file = req.files?.file?.[0];

            // If they provided a new file, we replace the old one
            if (file) {
                const isRaw =
                    !file.mimetype.startsWith("image/") &&
                    !file.mimetype.startsWith("video/");
                const cloudinaryResult = await uploadToCloudinary(
                    file.buffer,
                    `materials/${offeringId}`,
                    isRaw,
                );

                // Delete old file from Cloudinary (if there is one)
                if (!material.isExternalLink && material.url) {
                    try {
                        await deleteFromCloudinary(material.url);
                    } catch (err) {
                        console.warn(
                            `[WARNING] Failed to delete old file from Cloudinary for material ${id}`,
                        );
                    }
                }

                material.url = cloudinaryResult.secure_url;
                material.fileName = file.originalname;
                material.fileType = file.mimetype;
                material.isExternalLink = false;
            } else if (material.isExternalLink && newIsExternalLink === false) {
                // They trying to switch from Link -> File without providing a file
                return next(
                    new AppError(
                        "A file is required when switching to a non-link material.",
                        400,
                    ),
                );
            }
        }
    }

    await material.save();

    res.status(200).json({
        status: "success",
        data: { material },
    });
});

/**
 * Delete a material (hard delete)
 *
 * Business Logic:
 * 1. Fetch material with tenant isolation
 * 2. Permission check:
 *    - Doctors: Can delete any material in their course
 *    - TAs: Can only delete their own materials
 * 3. Delete document from database
 *
 * @route   DELETE /api/v1/offerings/:offeringId/materials/:id
 * @access  Doctors (any material) & TAs (own materials only)
 *
 * @param   {Object} req.params.offeringId - Course offering ID
 * @param   {Object} req.params.id - Material ID
 * @param   {Object} req.user - Authenticated user
 * @param   {Object} req.scopeFilter - Tenant filter
 *
 * @returns {Object} 204 - No content
 * @throws  {AppError} 403 - You can only delete your own materials (TAs)
 * @throws  {AppError} 404 - Material not found
 *
 * @note File deletion from Cloudinary should be handled separately (future enhancement)
 */
export const deleteMaterial = catchAsync(async (req, res, next) => {
    const { offeringId, id } = req.params;

    // Step 1: Fetch material with tenant isolation
    const material = await Material.findOne({
        _id: id,
        courseOffering_id: offeringId,
        ...req.scopeFilter,
    });

    if (!material) {
        return next(new AppError("Material not found.", 404));
    }

    // Step 2: Permission check (TAs can only delete their own materials)
    if (
        req.user.role === "ta" &&
        material.uploadedBy_id.toString() !== req.user._id.toString()
    ) {
        return next(
            new AppError("You can only delete your own materials.", 403),
        );
    }

    // Step 3: Delete material from Cloudinary (if not an external link)
    if (!material.isExternalLink && material.url) {
        try {
            await deleteFromCloudinary(material.url);
        } catch (err) {
            console.warn(
                `[WARNING] Failed to delete file from Cloudinary for material ${id}`,
            );
        }
    }

    // Step 4: Delete material from Database
    await material.deleteOne();

    res.status(204).json(null);
});
