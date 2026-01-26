const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

let _schemaEnsuredPromise = null;

async function ensureAdminSchema() {
  if (_schemaEnsuredPromise) return _schemaEnsuredPromise;

  _schemaEnsuredPromise = (async () => {
    // Partner metadata columns (idempotent)
    // NOTE: We avoid foreign keys because we can't assume partner id type.
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS company_name text");
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS business_address text");
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS gst_number text");
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS pan_number text");
    await pool.query(
      "ALTER TABLE partners ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'approved'"
    );
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS rejection_reason text");
    await pool.query(
      "ALTER TABLE partners ADD COLUMN IF NOT EXISTS credit_balance numeric DEFAULT 0"
    );
    await pool.query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true");
    await pool.query(
      "ALTER TABLE partners ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()"
    );

    // Credit plans
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

    // Partner verification history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partner_verification_history (
        id bigserial PRIMARY KEY,
        partner_id text NOT NULL,
        action_type text NOT NULL,
        message_from_admin text,
        message_from_partner text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Partner serviceable pincodes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partner_serviceable_pincodes (
        id bigserial PRIMARY KEY,
        partner_id text NOT NULL,
        pincode text NOT NULL,
        city text,
        state text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  })();

  return _schemaEnsuredPromise;
}

function generateAdminToken(admin) {
  return jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      userType: "admin",
      role: admin.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function getConfiguredAdmin() {
  const email = String(process.env.ADMIN_EMAIL || "admin@reprice.local").trim();
  const fullName = String(process.env.ADMIN_FULL_NAME || "Admin").trim();
  const role = String(process.env.ADMIN_ROLE || "super_admin").trim();

  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  return {
    id: 1,
    email,
    full_name: fullName,
    role,
    is_active: true,
    password,
    passwordHash,
  };
}

exports.adminLogin = async (req, res) => {
  const { email, password } = req.body ?? {};

  const admin = getConfiguredAdmin();

  if (!admin.password && !admin.passwordHash) {
    return res.status(500).json({
      success: false,
      message: "Admin login not configured on server (set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH)",
    });
  }

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "email and password are required",
    });
  }

  if (String(email).trim().toLowerCase() !== admin.email.toLowerCase()) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const provided = String(password);

  let ok = false;
  if (admin.passwordHash) {
    ok = await bcrypt.compare(provided, admin.passwordHash);
  } else {
    ok = provided === String(admin.password);
  }

  if (!ok) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const accessToken = generateAdminToken(admin);

  return res.json({
    access_token: accessToken,
    admin: {
      id: admin.id,
      email: admin.email,
      full_name: admin.full_name,
      role: admin.role,
      is_active: admin.is_active,
    },
  });
};

exports.adminMe = async (req, res) => {
  const admin = getConfiguredAdmin();
  return res.json({
    id: admin.id,
    email: admin.email,
    full_name: admin.full_name,
    role: admin.role,
    is_active: admin.is_active,
  });
};

exports.getDashboardStats = async (req, res) => {
  await ensureAdminSchema();

  try {
    const [customers, partners, agents, orders, ordersByStatus, creditsSum] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM customers"),
      pool.query("SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE is_active = true)::int AS active FROM partners"),
      pool.query("SELECT COUNT(*)::int AS c FROM agents"),
      pool.query("SELECT COUNT(*)::int AS c FROM orders"),
      pool.query("SELECT status, COUNT(*)::int AS c FROM orders GROUP BY status"),
      pool.query("SELECT COALESCE(SUM(credit_balance), 0)::numeric AS s FROM partners"),
    ]);

    const pendingVerifications = await pool.query(
      "SELECT COUNT(*)::int AS c FROM partners WHERE verification_status IN ('pending','under_review','clarification_needed')"
    );

    const revenue = await pool.query(
      "SELECT COALESCE(SUM(price),0)::numeric AS s FROM orders WHERE status IN ('completed','picked_up')"
    );

    const orders_by_status = {};
    for (const row of ordersByStatus.rows) {
      orders_by_status[row.status] = row.c;
    }

    res.json({
      total_customers: customers.rows[0]?.c ?? 0,
      total_partners: partners.rows[0]?.c ?? 0,
      active_partners: partners.rows[0]?.active ?? 0,
      pending_verifications: pendingVerifications.rows[0]?.c ?? 0,
      total_agents: agents.rows[0]?.c ?? 0,
      total_orders: orders.rows[0]?.c ?? 0,
      orders_by_status,
      total_revenue: Number(revenue.rows[0]?.s ?? 0),
      credits_in_circulation: Number(creditsSum.rows[0]?.s ?? 0),
    });
  } catch (err) {
    console.error("ADMIN DASHBOARD STATS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to compute dashboard stats" });
  }
};

exports.listPartners = async (req, res) => {
  await ensureAdminSchema();

  try {
    const { verification_status } = req.query ?? {};

    const where = [];
    const params = [];

    if (verification_status) {
      params.push(String(verification_status));
      where.push(`verification_status = $${params.length}`);
    }

    const sql = `
      SELECT
        id,
        email,
        name AS full_name,
        phone,
        company_name,
        verification_status,
        COALESCE(credit_balance, 0) AS credit_balance,
        COALESCE(is_active, true) AS is_active,
        created_at
      FROM partners
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
    `;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("ADMIN LIST PARTNERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch partners" });
  }
};

exports.listPendingPartners = async (req, res) => {
  await ensureAdminSchema();

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        email,
        name AS full_name,
        phone,
        company_name,
        verification_status,
        COALESCE(credit_balance, 0) AS credit_balance,
        COALESCE(is_active, true) AS is_active,
        created_at
      FROM partners
      WHERE verification_status IN ('pending','under_review','clarification_needed')
      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("ADMIN LIST PENDING PARTNERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch pending partners" });
  }
};

exports.getPartnerVerificationDetails = async (req, res) => {
  await ensureAdminSchema();

  try {
    const partnerId = String(req.params.id);

    const partnerResult = await pool.query(
      `
      SELECT
        id,
        email,
        name AS full_name,
        phone,
        company_name,
        business_address,
        gst_number,
        pan_number,
        verification_status,
        rejection_reason,
        COALESCE(credit_balance, 0) AS credit_balance,
        COALESCE(is_active, true) AS is_active,
        created_at
      FROM partners
      WHERE id::text = $1
      LIMIT 1
      `,
      [partnerId]
    );

    if (partnerResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    const [pincodes, history] = await Promise.all([
      pool.query(
        `
        SELECT id, pincode, city, state, is_active
        FROM partner_serviceable_pincodes
        WHERE partner_id = $1
        ORDER BY id DESC
        `,
        [partnerId]
      ),
      pool.query(
        `
        SELECT id, action_type, message_from_admin, message_from_partner, created_at
        FROM partner_verification_history
        WHERE partner_id = $1
        ORDER BY created_at DESC
        `,
        [partnerId]
      ),
    ]);

    res.json({
      partner: partnerResult.rows[0],
      serviceable_pincodes: pincodes.rows,
      verification_history: history.rows,
    });
  } catch (err) {
    console.error("ADMIN PARTNER DETAILS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch partner details" });
  }
};

async function writePartnerHistory(partnerId, actionType, messageFromAdmin) {
  await pool.query(
    `
    INSERT INTO partner_verification_history (partner_id, action_type, message_from_admin)
    VALUES ($1, $2, $3)
    `,
    [String(partnerId), String(actionType), messageFromAdmin ?? null]
  );
}

exports.approvePartner = async (req, res) => {
  await ensureAdminSchema();

  try {
    const partnerId = String(req.params.id);
    const approvalNotes = req.body?.approval_notes ?? null;

    const result = await pool.query(
      `
      UPDATE partners
      SET verification_status = 'approved',
          rejection_reason = NULL,
          is_active = true
      WHERE id::text = $1
      RETURNING id
      `,
      [partnerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    await writePartnerHistory(partnerId, "approved", approvalNotes);

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN APPROVE PARTNER ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to approve partner" });
  }
};

exports.rejectPartner = async (req, res) => {
  await ensureAdminSchema();

  try {
    const partnerId = String(req.params.id);
    const rejectionReason = String(req.body?.rejection_reason ?? "").trim();

    if (!rejectionReason) {
      return res.status(400).json({ success: false, detail: "rejection_reason is required" });
    }

    const result = await pool.query(
      `
      UPDATE partners
      SET verification_status = 'rejected',
          rejection_reason = $2,
          is_active = false
      WHERE id::text = $1
      RETURNING id
      `,
      [partnerId, rejectionReason]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    await writePartnerHistory(partnerId, "rejected", rejectionReason);

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN REJECT PARTNER ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to reject partner" });
  }
};

exports.requestClarification = async (req, res) => {
  await ensureAdminSchema();

  try {
    const partnerId = String(req.params.id);
    const message = String(req.body?.message ?? "").trim();

    if (!message) {
      return res.status(400).json({ success: false, detail: "message is required" });
    }

    const result = await pool.query(
      `
      UPDATE partners
      SET verification_status = 'clarification_needed'
      WHERE id::text = $1
      RETURNING id
      `,
      [partnerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    await writePartnerHistory(partnerId, "clarification_needed", message);

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN REQUEST CLARIFICATION ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to request clarification" });
  }
};

exports.listOrders = async (req, res) => {
  await ensureAdminSchema();

  try {
    const { status } = req.query ?? {};

    const where = [];
    const params = [];

    if (status) {
      params.push(String(status));
      where.push(`o.status = $${params.length}`);
    }

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.phone_model AS phone_name,
        c.name AS customer_name,
        a.name AS agent_name,
        o.status,
        COALESCE(o.price, 0) AS quoted_price,
        COALESCE(o.created_at, now()) AS created_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN agents a ON o.agent_id = a.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY o.id DESC
      `,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error("ADMIN LIST ORDERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, email, name AS full_name
      FROM customers
      ORDER BY id DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("ADMIN LIST USERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch customers" });
  }
};

exports.createUser = async (req, res) => {
  const { full_name, email, phone, password } = req.body ?? {};

  try {
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, detail: "full_name, email, phone, password are required" });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const result = await pool.query(
      `
      INSERT INTO customers (name, email, phone, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, name AS full_name
      `,
      [String(full_name), String(email), String(phone), passwordHash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("ADMIN CREATE USER ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create customer" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const id = String(req.params.id);

    // best-effort delete (may fail due to FK constraints)
    await pool.query("DELETE FROM customers WHERE id::text = $1", [id]);

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN DELETE USER ERROR:", err);
    res.status(409).json({ success: false, message: "Failed to delete customer (may have related orders)" });
  }
};

exports.listCreditPlans = async (req, res) => {
  await ensureAdminSchema();

  try {
    const result = await pool.query(
      `
      SELECT id, plan_name, credit_amount, price, bonus_percentage, description, is_active, created_at
      FROM credit_plans
      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("ADMIN LIST CREDIT PLANS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch credit plans" });
  }
};

exports.createCreditPlan = async (req, res) => {
  await ensureAdminSchema();

  const { plan_name, credit_amount, price, bonus_percentage, description } = req.body ?? {};

  try {
    if (!plan_name || credit_amount == null || price == null) {
      return res.status(400).json({ success: false, detail: "plan_name, credit_amount, price are required" });
    }

    const result = await pool.query(
      `
      INSERT INTO credit_plans (plan_name, credit_amount, price, bonus_percentage, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        String(plan_name),
        Number(credit_amount),
        Number(price),
        Number(bonus_percentage ?? 0),
        description ?? null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("ADMIN CREATE CREDIT PLAN ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create credit plan" });
  }
};

exports.updateCreditPlan = async (req, res) => {
  await ensureAdminSchema();

  const id = String(req.params.id);
  const { plan_name, credit_amount, price, bonus_percentage, description } = req.body ?? {};

  try {
    const result = await pool.query(
      `
      UPDATE credit_plans
      SET plan_name = $2,
          credit_amount = $3,
          price = $4,
          bonus_percentage = $5,
          description = $6
      WHERE id::text = $1
      RETURNING *
      `,
      [
        id,
        String(plan_name),
        Number(credit_amount),
        Number(price),
        Number(bonus_percentage ?? 0),
        description ?? null,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Credit plan not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ADMIN UPDATE CREDIT PLAN ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update credit plan" });
  }
};

exports.deactivateCreditPlan = async (req, res) => {
  await ensureAdminSchema();

  const id = String(req.params.id);

  try {
    const result = await pool.query(
      `
      UPDATE credit_plans
      SET is_active = false
      WHERE id::text = $1
      RETURNING id
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Credit plan not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN DELETE CREDIT PLAN ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to deactivate credit plan" });
  }
};
