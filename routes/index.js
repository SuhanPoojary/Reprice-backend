const express = require("express");
const router = express.Router();

const authRoutes = require("./authRoutes");
const orderRoutes = require("./orderRoutes");
const agentRoutes = require("./agentRoutes");

router.use("/auth", authRoutes);
router.use("/orders", orderRoutes);
router.use("/agent", agentRoutes);

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "MobileTrade API is running",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
router.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

module.exports = router;
