const express = require("express");
const router = express.Router();

const creditController = require("../controllers/creditController");
const { authenticateToken, isPartner } = require("../middleware/authMiddleware");

router.use(authenticateToken, isPartner);

router.get("/balance", creditController.getMyCreditBalance);
router.get("/history", creditController.getMyCreditHistory);
router.get("/plans", creditController.listMyPlans);
router.post("/plans/:id/buy", creditController.buyPlan);

module.exports = router;
