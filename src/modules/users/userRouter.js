import express from "express";
import * as userController from "./userController.js";
import { protect } from "../../middlewares/protect.js";
const router = express.Router();

router.route("/").post(userController.createUser);

export default router;