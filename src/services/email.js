import nodemailer from "nodemailer";
import { htmlToText } from "html-to-text";

/**
 * Email Service Class to handle sending emails.
 * @class Email
 */
export default class Email {
    /**
     * Create an Email instance.
     * @constructor
     * @param {Object} user - User object.
     * @param {string} user.email - User's email address.
     * @param {string} user.name - User's full name.
     * @param {string} url - Action URL (e.g., reset link, verification link).
     */
    constructor(user, url) {
        this.to = user.email;
        this.firstName = user.name.split(" ")[0] || "User";
        this.url = url;
        this.from = `Smart University <${process.env.EMAIL_FROM}>`;
    }

    /**
     * Create a new Nodemailer transport based on environment.
     * @returns {Object} Nodemailer transport object.
     */
    newTransport() {
        if (process.env.NODE_ENV === "production") {
            // Brevo (Sendinblue) Configuration
            return nodemailer.createTransport({
                host: process.env.BREVO_HOST,
                port: process.env.BREVO_PORT,
                secure: false, // Brevo بيستخدم بورت 587 مع starttls، يبقى secure: false
                auth: {
                    user: process.env.BREVO_USER,
                    pass: process.env.BREVO_PASSWORD,
                },
            });
        }

        // Development (Mailtrap)
        return nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: process.env.EMAIL_PORT,
            auth: {
                user: process.env.EMAIL_USERNAME,
                pass: process.env.EMAIL_PASSWORD,
            },
        });
    }

    /**
     * Send the actual email.
     * @async
     * @param {string} subject - Email subject.
     * @param {string} message - Email HTML content.
     * @returns {Promise<void>}
     */
    async send(subject, message) {
        const mailOptions = {
            from: this.from,
            to: this.to,
            subject,
            html: message,
            text: htmlToText(message),
        };

        await this.newTransport().sendMail(mailOptions);
    }

    /**
     * Send a welcome email to the user.
     * @async
     * @returns {Promise<void>}
     */
    async sendWelcome() {
        await this.send(
            "Welcome to the Smart University Family!",
            `<h1>Hi ${this.firstName},</h1><p>Welcome to our platform. Please click <a href="${this.url}">here</a> to complete your profile.</p>`,
        );
    }

    /**
     * Send a password reset email.
     * @async
     * @returns {Promise<void>}
     */
    async sendPasswordReset() {
        await this.send(
            "🔒 Reset your password",
            `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Reset Password</title>
                <style>
                    /* Reset styles */
                    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
                    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
                    img { -ms-interpolation-mode: bicubic; }
                    
                    /* Modern Variables (simulated) */
                    body {
                        margin: 0;
                        padding: 0;
                        background-color: #f3f4f6; /* Light Gray Background */
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    }

                    /* Responsive Grid */
                    .wrapper {
                        width: 100%;
                        table-layout: fixed;
                        background-color: #f3f4f6;
                        padding-bottom: 40px;
                    }

                    .main-content {
                        background-color: #ffffff;
                        margin: 0 auto;
                        width: 100%;
                        max-width: 600px;
                        border-radius: 12px; /* Rounded Corners */
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); /* Modern Shadow */
                        overflow: hidden;
                    }

                    /* Typography */
                    h1 {
                        color: #111827;
                        font-size: 24px;
                        font-weight: 700;
                        margin: 0 0 16px;
                        text-align: center;
                    }

                    p {
                        color: #4b5563;
                        font-size: 16px;
                        line-height: 24px;
                        margin: 0 0 16px;
                    }

                    /* Button Style */
                    .btn-primary {
                        background-color: #2563eb; /* Modern Bright Blue */
                        border-radius: 8px;
                        color: #ffffff;
                        display: inline-block;
                        font-size: 16px;
                        font-weight: 600;
                        line-height: 50px;
                        text-align: center;
                        text-decoration: none;
                        width: 100%;
                        box-shadow: 0 4px 6px rgba(37, 99, 235, 0.2);
                        transition: background-color 0.3s ease;
                    }
                    
                    .btn-primary:hover {
                        background-color: #1d4ed8;
                    }

                    /* Footer */
                    .footer {
                        padding-top: 24px;
                        text-align: center;
                        color: #9ca3af;
                        font-size: 12px;
                    }

                    /* Mobile Responsiveness */
                    @media screen and (max-width: 600px) {
                        .main-content {
                            width: 100% !important;
                            border-radius: 0 !important;
                        }
                        .content-padding {
                            padding: 24px !important;
                        }
                        h1 {
                            font-size: 22px !important;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="wrapper">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                            <td align="center" style="padding: 40px 10px;">
                                
                                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px;">
                                    <tr>
                                        <td align="center" style="padding-bottom: 20px;">
                                            <h2 style="margin: 0; color: #1e3a8a; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">
                                                🎓 Smart University
                                            </h2>
                                        </td>
                                    </tr>
                                </table>

                                <table border="0" cellpadding="0" cellspacing="0" width="100%" class="main-content">
                                    
                                    <tr>
                                        <td bgcolor="#2563eb" style="height: 6px;"></td>
                                    </tr>

                                    <tr>
                                        <td class="content-padding" style="padding: 40px;">
                                            <div style="text-align: center; margin-bottom: 20px;">
                                                <div style="display: inline-block; padding: 12px; background-color: #eff6ff; border-radius: 50%;">
                                                    <span style="font-size: 30px;">🔒</span>
                                                </div>
                                            </div>

                                            <h1>Reset Your Password</h1>
                                            
                                            <p>Hi <strong>${this.firstName}</strong>,</p>
                                            <p>We received a request to reset the password for your account. No changes have been made to your account yet.</p>
                                            <p>You can reset your password by clicking the link below:</p>

                                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 24px 0;">
                                                <tr>
                                                    <td align="center">
                                                        <a href="${this.url}" target="_blank" class="btn-primary">Reset Your Password</a>
                                                    </td>
                                                </tr>
                                            </table>

                                            <p style="font-size: 14px; color: #6b7280; text-align: center;">This link will expire in <strong>10 minutes</strong>.</p>
                                            
                                            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;">
                                            
                                            <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
                                                If the button above doesn't work, copy and paste this link into your browser:
                                            </p>
                                            <p style="font-size: 13px; color: #2563eb; word-break: break-all;">
                                                <a href="${this.url}" style="color: #2563eb;">${this.url}</a>
                                            </p>
                                        </td>
                                    </tr>
                                </table>

                                <div class="footer">
                                    <p>Smart University Platform<br>Beni-Suef, Egypt</p>
                                    <p style="margin-top: 10px;">If you didn't request this, you can safely ignore this email.</p>
                                </div>

                            </td>
                        </tr>
                    </table>
                </div>
            </body>
            </html>
            `,
        );
    }

    /**
     * Send a 2FA verification code email.
     * @async
     * @param {string} otpCode - The One-Time Password code.
     * @param {string} [msg=""] - Context message (e.g., "Login", "Update Password").
     * @returns {Promise<void>}
     */
    async send2FACode(otpCode, msg = "") {
        await this.send(
            `🔒 Your ${msg} Verification Code`,
            `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Verification Code</title>
                <style>
                    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
                    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
                    img { -ms-interpolation-mode: bicubic; }
                    body { margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                    .wrapper { width: 100%; table-layout: fixed; background-color: #f3f4f6; padding-bottom: 40px; }
                    .main-content { background-color: #ffffff; margin: 0 auto; width: 100%; max-width: 600px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden; }
                    h1 { color: #111827; font-size: 24px; font-weight: 700; margin: 0 0 16px; text-align: center; }
                    p { color: #4b5563; font-size: 16px; line-height: 24px; margin: 0 0 16px; }
                    .footer { padding-top: 24px; text-align: center; color: #9ca3af; font-size: 12px; }
                    @media screen and (max-width: 600px) { .main-content { width: 100% !important; border-radius: 0 !important; } .content-padding { padding: 24px !important; } }
                </style>
            </head>
            <body>
                <div class="wrapper">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                            <td align="center" style="padding: 40px 10px;">
                                
                                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px;">
                                    <tr>
                                        <td align="center" style="padding-bottom: 20px;">
                                            <h2 style="margin: 0; color: #1e3a8a; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">🎓 Smart University</h2>
                                        </td>
                                    </tr>
                                </table>

                                <table border="0" cellpadding="0" cellspacing="0" width="100%" class="main-content">
                                    <tr><td bgcolor="#2563eb" style="height: 6px;"></td></tr>
                                    <tr>
                                        <td class="content-padding" style="padding: 40px;">
                                            <div style="text-align: center; margin-bottom: 20px;">
                                                <div style="display: inline-block; padding: 12px; background-color: #eff6ff; border-radius: 50%;">
                                                    <span style="font-size: 30px;">🛡️</span>
                                                </div>
                                            </div>

                                            <h1>${msg} Verification</h1>
                                            
                                            <p style="text-align: center;">Hi <strong>${this.firstName}</strong>,</p>
                                            <p style="text-align: center;">Please use the verification code below to complete your ${msg} process:</p>

                                            <div style="text-align: center; margin: 30px 0;">
                                                <span style="font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #1e3a8a; background-color: #f3f4f6; padding: 15px 30px; border-radius: 8px; border: 1px solid #e5e7eb; display: inline-block;">
                                                    ${otpCode}
                                                </span>
                                            </div>

                                            <p style="font-size: 14px; color: #6b7280; text-align: center; margin-bottom: 0;">
                                                This code is valid for <strong>10 minutes</strong>.
                                                <br>Do not share this code with anyone.
                                            </p>
                                        </td>
                                    </tr>
                                </table>

                                <div class="footer">
                                    <p>Smart University Platform<br>Beni-Suef, Egypt</p>
                                    <p style="margin-top: 10px;">If you didn't attempt to ${msg}, please change your password immediately.</p>
                                </div>

                            </td>
                        </tr>
                    </table>
                </div>
            </body>
            </html>
            `,
        );
    }

    /**
     * Send user credentials email.
     * @async
     * @param {string} password - The user's temporary password.
     * @returns {Promise<void>}
     */
    async sendCredentials(password) {
        await this.send(
            `🔐 Your Account Credentials`,
            `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Account Credentials</title>
                <style>
                    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
                    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
                    img { -ms-interpolation-mode: bicubic; }
                    body { margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                    .wrapper { width: 100%; table-layout: fixed; background-color: #f3f4f6; padding-bottom: 40px; }
                    .main-content { background-color: #ffffff; margin: 0 auto; width: 100%; max-width: 600px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden; }
                    h1 { color: #111827; font-size: 24px; font-weight: 700; margin: 0 0 16px; text-align: center; }
                    p { color: #4b5563; font-size: 16px; line-height: 24px; margin: 0 0 16px; }
                    .footer { padding-top: 24px; text-align: center; color: #9ca3af; font-size: 12px; }
                    @media screen and (max-width: 600px) { .main-content { width: 100% !important; border-radius: 0 !important; } .content-padding { padding: 24px !important; } }
                </style>
            </head>
            <body>
                <div class="wrapper">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                            <td align="center" style="padding: 40px 10px;">
                                
                                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px;">
                                    <tr>
                                        <td align="center" style="padding-bottom: 20px;">
                                            <h2 style="margin: 0; color: #1e3a8a; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">🎓 Smart University</h2>
                                        </td>
                                    </tr>
                                </table>

                                <table border="0" cellpadding="0" cellspacing="0" width="100%" class="main-content">
                                    <tr><td bgcolor="#2563eb" style="height: 6px;"></td></tr>
                                    <tr>
                                        <td class="content-padding" style="padding: 40px;">
                                            <div style="text-align: center; margin-bottom: 20px;">
                                                <div style="display: inline-block; padding: 12px; background-color: #eff6ff; border-radius: 50%;">
                                                    <span style="font-size: 30px;">🔐</span>
                                                </div>
                                            </div>

                                            <h1>Account Credentials</h1>
                                            
                                            <p style="text-align: center;">Hi <strong>${this.firstName}</strong>,</p>
                                            <p style="text-align: center;">Welcome to Smart University! Here are your account credentials:</p>

                                            <p style="text-align: center; margin-bottom: 10px;">
                                                <strong>Email:</strong> ${this.to}
                                            </p>

                                            <p style="text-align: center; margin-bottom: 5px;">
                                                <strong>Temporary Password:</strong>
                                            </p>

                                            <div style="text-align: center; margin: 15px 0 30px 0;">
                                                <span style="font-size: 24px; font-weight: 800; letter-spacing: 2px; color: #1e3a8a; background-color: #f3f4f6; padding: 15px 30px; border-radius: 8px; border: 1px solid #e5e7eb; display: inline-block;">
                                                    ${password}
                                                </span>
                                            </div>

                                            <p style="font-size: 14px; color: #6b7280; text-align: center; margin-bottom: 0;">
                                                Please log in and change your password immediately.
                                                <br>Do not share these credentials with anyone.
                                            </p>
                                        </td>
                                    </tr>
                                </table>

                                <div class="footer">
                                    <p>Smart University Platform<br>Beni-Suef, Egypt</p>
                                    <p style="margin-top: 10px;">If you have any issues, please contact the administration.</p>
                                </div>

                            </td>
                        </tr>
                    </table>
                </div>
            </body>
            </html>
            `,
        );
    }
}
