import express from "express";
import * as userController from "./userController.js";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";
const router = express.Router();

router.use(protect);

// 'student', 'ta', 'doctor', 'collegeAdmin', 'universityAdmin'

router.route("/me").get(userController.getMe);

router.route("/")
    .post(restrictTo("universityAdmin", "collegeAdmin"), userController.createUser)
    .get(restrictTo("universityAdmin", "collegeAdmin", "ta", "doctor"), userController.getAllUsers);

router.route("/:id")
    .get(restrictTo("universityAdmin", "collegeAdmin", "ta", "doctor"), userController.getUser)
    .patch(restrictTo("universityAdmin", "collegeAdmin"), userController.updateUser)
    .delete(restrictTo("universityAdmin", "collegeAdmin"), userController.deleteUser);


export default router;