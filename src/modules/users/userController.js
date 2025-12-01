import User from "../../../DB/models/userModel.js";
import catchAsync from "../../utils/catchAsync.js";

export const createUser = catchAsync(async (req, res, next) => {
    const { name, email, password, passwordConfirm, nationalID, role, department_id, phoneNumber, photo } = req.body;

    if (!name || !email || !password || !passwordConfirm || !nationalID || !phoneNumber) {
        return next(new AppError("Please provide all required fields", 400));
    }

    if (password !== passwordConfirm) {
        return next(new AppError("Password does not match", 400));
    }

    const user = await User.create({ name, email, password, nationalID, role, department_id, phoneNumber, photo });
    user.password = undefined;
    res.status(201).json({
        status: "success",
        data: {
            user,
        },
    });
});