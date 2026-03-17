import express from "express";
import * as authController from "./authController.js";

import { protect, restrictTo } from "../../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/forgotPassword", authController.forgotPassword);
router.patch("/resetPassword/:token", authController.resetPassword);

router.post("/login", authController.loginStepOne);
router.post("/login/verify", authController.loginStepTwo);

router.use(protect);

router.post("/logout", authController.logout);
router.post("/updatePassword", authController.initiateUpdatePassword);
router.post("/updatePassword/confirm", authController.confirmUpdatePassword);

export default router;
