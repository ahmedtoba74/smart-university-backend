import express from 'express';
import dotenv from 'dotenv';

// Load env vars
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Basic Middleware
app.use(express.json());

// Test Route
app.get('/', (req, res) => {
  res.status(200).json({ message: 'Smart University Backend is Running 🚀' });
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});