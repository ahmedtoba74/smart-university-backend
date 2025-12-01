import express from "express";
import * as userController from "./userController.js";

const router = express.Router();

router.route("/").post(userController.createUser);

export default router;