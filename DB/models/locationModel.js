import mongoose from "mongoose";

const locationSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Location name is required"],
        trim: true
    },
    readerId: {
        type: String,
        required: [true, "Reader ID is required"],
        unique: true,
        index: true,
        trim: true
    },

}, { timestamps: true });

const Location = mongoose.model("Location", locationSchema);
export default Location;
