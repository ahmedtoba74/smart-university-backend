import express from "express";
import * as authController from "./authController.js";

const router = express.Router();

router.route("/").post(authController.login);

export default router;