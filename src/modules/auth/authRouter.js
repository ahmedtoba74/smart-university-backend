import express from "express";
import * as authController from "./authController.js";

import { protect } from "../../middlewares/protect.js";

const router = express.Router();

router.route("/login").post(authController.login);
router.route("/logout").post(authController.logout);
router.route("/updatePassword").post(protect, authController.changePassword);

export default router;