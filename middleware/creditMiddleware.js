const creditService = require("../services/creditService");

// Usage: ensureOrderCredits({ orderLoader }) where orderLoader returns an order row (must include product fields)
exports.ensureOrderCredits = ({ orderLoader }) => {
  if (typeof orderLoader !== "function") {
    throw new Error("ensureOrderCredits requires orderLoader function");
  }

  return async (req, res, next) => {
    try {
      const partnerId = req.user?.id;
      if (!partnerId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const order = await orderLoader(req);
      if (!order) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      const { credits_required, product_key } = await creditService.getCreditCostForOrder(order);
      const balance = await creditService.getPartnerBalance(partnerId);

      if (balance == null) {
        return res.status(404).json({ success: false, message: "Partner not found" });
      }

      if (Number(balance) < Number(credits_required)) {
        return res.status(402).json({
          success: false,
          message: "Insufficient Credits",
          required_credits: credits_required,
          balance,
          product_key,
        });
      }

      req.credit = { required_credits: credits_required, product_key, balance };
      return next();
    } catch (err) {
      console.error("CREDIT MIDDLEWARE ERROR:", err);
      return res.status(500).json({ success: false, message: "Credit check failed" });
    }
  };
};
