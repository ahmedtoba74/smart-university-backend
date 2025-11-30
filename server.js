import dotenv from 'dotenv';
import dbConnection from './DB/dbConnection.js';
import app from './app.js';

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception! Shutting down...");
    console.error(err.name, err.message);
    process.exit(1);
});

dotenv.config();

const port = process.env.PORT || 3000;

dbConnection();

const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection! Shutting down...");
    console.error(err.name, err.message);
    server.close(() => {
        process.exit(1);
    });
});