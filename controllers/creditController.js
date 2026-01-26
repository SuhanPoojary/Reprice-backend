const { pool } = require("../db");
const creditService = require("../services/creditService");

// Partner endpoints
exports.getMyCreditBalance = async (req, res) => {
  try {
    const partnerId = req.user.id;
    const balance = await creditService.getPartnerBalance(partnerId);
    if (balance == null) return res.status(404).json({ success: false, message: "Partner not found" });
    return res.json({ success: true, balance });
  } catch (err) {
    console.error("GET MY CREDIT BALANCE ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch balance" });
  }
};

exports.getMyCreditHistory = async (req, res) => {
  try {
    const partnerId = req.user.id;
    const limit = Math.min(Number(req.query?.limit ?? 200), 500);
    const txns = await creditService.listTransactions({ partnerId, limit, offset: 0 });
    return res.json({ success: true, transactions: txns });
  } catch (err) {
    console.error("GET MY CREDIT HISTORY ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch credit history" });
  }
};

exports.listMyPlans = async (req, res) => {
  try {
    await creditService.ensureCreditSchema();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_plans (
        id bigserial PRIMARY KEY,
        plan_name text NOT NULL,
        credit_amount numeric NOT NULL,
        price numeric NOT NULL,
        bonus_percentage numeric NOT NULL DEFAULT 0,
        description text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const r = await pool.query(
      `
      SELECT id, plan_name, credit_amount, price, bonus_percentage, description, is_active
      FROM credit_plans
      WHERE is_active = true
      ORDER BY price ASC
      `
    );

    return res.json({ success: true, plans: r.rows });
  } catch (err) {
    console.error("LIST MY PLANS ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch plans" });
  }
};

exports.buyPlan = async (req, res) => {
  try {
    const partnerId = req.user.id;
    const planId = req.params.id;
    const payment_reference = req.body?.payment_reference;

    const result = await creditService.purchasePlan({ partnerId, planId, paymentReference: payment_reference });

    if (!result.ok) {
      return res.status(404).json({ success: false, message: result.message });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("BUY PLAN ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to buy plan" });
  }
};

// Admin endpoints
exports.listPartnerBalances = async (req, res) => {
  try {
    await creditService.ensureCreditSchema();
    const r = await pool.query(
      `
      SELECT
        id,
        name AS full_name,
        email,
        phone,
        COALESCE(credit_balance,0) AS credit_balance,
        COALESCE(verification_status,'approved') AS verification_status,
        COALESCE(is_active,true) AS is_active,
        created_at
      FROM partners
      ORDER BY created_at DESC
      `
    );

    return res.json({ success: true, partners: r.rows });
  } catch (err) {
    console.error("ADMIN LIST PARTNER BALANCES ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch partner balances" });
  }
};

exports.adjustPartnerCredits = async (req, res) => {
  const { partnerId, delta, reason } = req.body ?? {};

  try {
    if (!partnerId || delta == null) {
      return res.status(400).json({ success: false, message: "partnerId and delta are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await creditService.addCredits({
        partnerId,
        credits: Number(delta),
        referenceType: "admin_adjust",
        referenceId: String(req.user?.id ?? "admin"),
        message: reason ? String(reason) : "Admin adjustment",
        metadata: { admin_id: req.user?.id, reason: reason ?? null },
        client,
      });

      await client.query("COMMIT");
      return res.json({ success: true, balance: result.balance });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }

      if (err?.code === "INSUFFICIENT_CREDITS") {
        return res.status(409).json({
          success: false,
          message: "Credits cannot go negative",
          balance: err.balance,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("ADMIN ADJUST CREDITS ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to adjust credits" });
  }
};

exports.listAllTransactions = async (req, res) => {
  try {
    const partnerId = req.query?.partnerId;
    const limit = Math.min(Number(req.query?.limit ?? 200), 1000);
    const offset = Math.max(Number(req.query?.offset ?? 0), 0);
    const txns = await creditService.listTransactions({ partnerId, limit, offset });
    return res.json({ success: true, transactions: txns });
  } catch (err) {
    console.error("ADMIN LIST TRANSACTIONS ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch transactions" });
  }
};

exports.listProductCosts = async (req, res) => {
  try {
    const rows = await creditService.listProductCosts();
    return res.json({ success: true, product_costs: rows });
  } catch (err) {
    console.error("ADMIN LIST PRODUCT COSTS ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch product costs" });
  }
};

exports.upsertProductCost = async (req, res) => {
  const { product_key, credits_per_order, credits_per_1000_rupees, discount_rupees_per_credit, max_discount_rupees, is_active } = req.body ?? {};
  try {
    if (!product_key || credits_per_order == null) {
      return res.status(400).json({ success: false, message: "product_key and credits_per_order are required" });
    }

    if (Number(credits_per_order) < 0) {
      return res.status(400).json({ success: false, message: "credits_per_order cannot be negative" });
    }

    if (discount_rupees_per_credit != null && Number(discount_rupees_per_credit) < 0) {
      return res.status(400).json({ success: false, message: "discount_rupees_per_credit cannot be negative" });
    }

    if (max_discount_rupees != null && Number(max_discount_rupees) < 0) {
      return res.status(400).json({ success: false, message: "max_discount_rupees cannot be negative" });
    }

    if (credits_per_1000_rupees != null && Number(credits_per_1000_rupees) < 0) {
      return res.status(400).json({ success: false, message: "credits_per_1000_rupees cannot be negative" });
    }

    const row = await creditService.upsertProductCost({
      productKey: product_key,
      creditsPerOrder: credits_per_order,
      creditsPer1000Rupees: credits_per_1000_rupees ?? 0,
      discountRupeesPerCredit: discount_rupees_per_credit ?? 0,
      maxDiscountRupees: max_discount_rupees ?? 0,
      isActive: is_active !== false,
    });

    return res.json({ success: true, product_cost: row });
  } catch (err) {
    console.error("ADMIN UPSERT PRODUCT COST ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to update product cost" });
  }
};
