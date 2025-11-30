import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema({
    currentSemester: {
        type: String,
        required: true,
        default: "Fall 2025"
    },
    isEnrollmentOpen: {
        type: Boolean,
        default: false
    },
    gradePoints: {
        type: Map,
        of: Number,
        default: { 'A+': 4.0, 'A': 3.7, 'B+': 3.3, 'B': 3.0, 'C+': 2.7, 'C': 2.4, 'D+': 2.2, 'D': 2.0, 'F': 0.0 }
    },
    defaultCreditLimit: {
        good_standing: { type: Number, default: 18 },
        probation: { type: Number, default: 12 },
        honors: { type: Number, default: 21 }
    }
}, { timestamps: true });

// Singleton pattern enforcement
settingsSchema.statics.getSettings = async function() {
    const settings = await this.findOne();
    if (settings) return settings;
    return await this.create({});
};

const Settings = mongoose.model("Settings", settingsSchema);
export default Settings;
