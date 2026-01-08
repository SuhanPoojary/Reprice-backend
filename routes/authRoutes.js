const express = require("express");
const router = express.Router();

const authController = require("../controllers/authController");
const { authenticateToken } = require("../middleware/authMiddleware");

// Public routes
router.post("/signup", authController.signup);
router.post("/login", authController.login);

// Protected routes
router.get("/me", authenticateToken, authController.getCurrentUser);
router.post("/logout", authenticateToken, authController.logout);

module.exports = router;
