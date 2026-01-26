import express from "express";
import * as userController from "./userController.js";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";
import { uploadMix } from "../../middlewares/uploadMiddleware.js";
import { fileValidation } from "../../utils/fileExtensions.js";
const router = express.Router();

router.use(protect);

// 'student', 'ta', 'doctor', 'collegeAdmin', 'universityAdmin'

router.route("/me").get(userController.getMe, userController.getUser);
router.patch("/restoreByNationalID", restrictTo("universityAdmin", "collegeAdmin"), userController.restoreUserByNationalID);

router.route("/")
    .post(restrictTo("universityAdmin", "collegeAdmin"), uploadMix([{ name: 'photo', maxCount: 1 }], fileValidation.image), userController.createUser)
    .get(restrictTo("universityAdmin", "collegeAdmin", "ta", "doctor"), userController.getAllUsers);

router.route("/:id")
    .get(restrictTo("universityAdmin", "collegeAdmin", "ta", "doctor"), userController.getUser)
    .patch(restrictTo("universityAdmin", "collegeAdmin"), uploadMix([{ name: 'photo', maxCount: 1 }], fileValidation.image), userController.updateUser)
    .delete(restrictTo("universityAdmin", "collegeAdmin"), userController.deleteUser);


export default router;