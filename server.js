import express from 'express';
import dotenv from 'dotenv';
import dbConnection from './DB/dbConnection.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

dbConnection();

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});