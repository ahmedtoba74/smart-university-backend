import express from "express";
import * as userController from "./userController.js";
import { protect, restrictTo } from "../../middlewares/authMiddleware.js";
const router = express.Router();

router.use(protect);

router.route("/me").get(userController.getMe);

router.route("/")
    .post(userController.createUser)
    .get(userController.getAllUsers);

router.route("/:id")
    .get(userController.getUser)
    .patch(userController.updateUser)
    .delete(userController.deleteUser);


export default router;