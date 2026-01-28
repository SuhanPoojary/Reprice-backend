const express = require("express");
const router = express.Router();

const adminController = require("../controllers/adminController");
const vectorController = require("../controllers/vectorController");
const creditController = require("../controllers/creditController");
const { authenticateToken } = require("../middleware/authMiddleware");
const { isAdmin } = require("../middleware/adminMiddleware");

// Auth
router.post("/auth/login", adminController.adminLogin);
router.get("/auth/me", authenticateToken, isAdmin, adminController.adminMe);

// Dashboard
router.get("/dashboard/stats", authenticateToken, isAdmin, adminController.getDashboardStats);

// Partners
router.get("/partners", authenticateToken, isAdmin, adminController.listPartners);
router.get(
  "/partners/pending-verification",
  authenticateToken,
  isAdmin,
  adminController.listPendingPartners
);
router.get(
  "/partners/:id/verification-details",
  authenticateToken,
  isAdmin,
  adminController.getPartnerVerificationDetails
);
router.post(
  "/partners/:id/approve",
  authenticateToken,
  isAdmin,
  adminController.approvePartner
);
router.post(
  "/partners/:id/reject",
  authenticateToken,
  isAdmin,
  adminController.rejectPartner
);
router.post(
  "/partners/:id/request-clarification",
  authenticateToken,
  isAdmin,
  adminController.requestClarification
);

router.delete(
  "/partners/:id",
  authenticateToken,
  isAdmin,
  adminController.removePartner
);

// Orders
router.get("/orders", authenticateToken, isAdmin, adminController.listOrders);

// Vector DB (phones)
router.get("/vector/health", authenticateToken, isAdmin, vectorController.vectorHealth);
router.post(
  "/vector/phones/search",
  authenticateToken,
  isAdmin,
  vectorController.vectorSearchPhones
);
router.post(
  "/vector/phones/upsert",
  authenticateToken,
  isAdmin,
  vectorController.vectorUpsertPhone
);
router.post(
  "/vector/phones/upload-csv",
  authenticateToken,
  isAdmin,
  vectorController.vectorUploadPhonesCsv
);
router.delete(
  "/vector/phones/:id",
  authenticateToken,
  isAdmin,
  vectorController.vectorDeletePhone
);

// Customers
router.get("/users", authenticateToken, isAdmin, adminController.listUsers);
router.post("/users", authenticateToken, isAdmin, adminController.createUser);
router.delete("/users/:id", authenticateToken, isAdmin, adminController.deleteUser);

// Credit plans
router.get("/credit-plans", authenticateToken, isAdmin, adminController.listCreditPlans);
router.post("/credit-plans", authenticateToken, isAdmin, adminController.createCreditPlan);
router.put("/credit-plans/:id", authenticateToken, isAdmin, adminController.updateCreditPlan);
router.delete("/credit-plans/:id", authenticateToken, isAdmin, adminController.deactivateCreditPlan);

// Credits management
router.get("/credits/partners", authenticateToken, isAdmin, creditController.listPartnerBalances);
router.post("/credits/adjust", authenticateToken, isAdmin, creditController.adjustPartnerCredits);
router.get("/credits/transactions", authenticateToken, isAdmin, creditController.listAllTransactions);
router.get("/credits/product-costs", authenticateToken, isAdmin, creditController.listProductCosts);
router.post("/credits/product-costs", authenticateToken, isAdmin, creditController.upsertProductCost);

module.exports = router;
