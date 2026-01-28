const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { authenticateToken } = require("../middleware/authMiddleware");
const { noteAgentRejected } = require("../memory/orderMemory");
const creditService = require("../services/creditService");
const {
  lookupByPincode,
  normalizePincode,
  isValidIndianPincode,
} = require("../services/indiaPostService");
const { isServiceableForPartnerPins } = require("../services/pincodeRadiusService");

const SERVICE_RADIUS_KM = Number(process.env.SERVICE_RADIUS_KM || 20);

async function ensurePartnerServiceablePincodesSchema() {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS partner_serviceable_pincodes (
      id bigserial PRIMARY KEY,
      partner_id text NOT NULL,
      pincode text NOT NULL,
      city text,
      state text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
    `
  );

  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_partner_serviceable_pincodes_partner_id ON partner_serviceable_pincodes (partner_id)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_partner_serviceable_pincodes_pincode_active ON partner_serviceable_pincodes (pincode, is_active)"
  );
}

async function hasApprovedPartnerForPincode(pincode) {
  const pin = normalizePincode(pincode);
  if (!pin) return false;

  await ensurePartnerServiceablePincodesSchema();

  const hasIsActive = await hasColumn("partners", "is_active");
  const hasVerification = await hasColumn("partners", "verification_status");

  const partnerFilters = ["1=1"];
  if (hasIsActive) partnerFilters.push("p.is_active = true");
  if (hasVerification) partnerFilters.push("LOWER(COALESCE(p.verification_status,'')) = 'approved'");

  const result = await pool.query(
    `
    SELECT DISTINCT regexp_replace(sp.pincode, '\\D', '', 'g') AS pincode
    FROM partner_serviceable_pincodes sp
    JOIN partners p ON p.id::text = sp.partner_id
    WHERE sp.is_active = true
      AND ${partnerFilters.join(" AND ")}
    `
  );

  const partnerPins = result.rows.map((r) => r.pincode).filter(Boolean);
  if (partnerPins.length === 0) return false;

  const svc = await isServiceableForPartnerPins(pin, partnerPins, SERVICE_RADIUS_KM);
  return svc.ok ? svc.serviceable : false;
}

const _schemaCache = new Map();

async function hasColumn(tableName, columnName) {
  const key = `col:${tableName}.${columnName}`;
  if (_schemaCache.has(key)) return _schemaCache.get(key);

  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [tableName, columnName]
  );

  const exists = result.rows.length > 0;
  _schemaCache.set(key, exists);
  return exists;
}

async function hasTable(tableName) {
  const key = `tbl:${tableName}`;
  if (_schemaCache.has(key)) return _schemaCache.get(key);

  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
    LIMIT 1
    `,
    [tableName]
  );

  const exists = result.rows.length > 0;
  _schemaCache.set(key, exists);
  return exists;
}

async function isAnyAgentWithinKm(lat, lng, km) {
  const [hasLat, hasLng] = await Promise.all([
    hasColumn('agents', 'latitude'),
    hasColumn('agents', 'longitude'),
  ]);

  if (!hasLat || !hasLng) return false;

  const result = await pool.query(
    `
    SELECT 1
    FROM agents a
    WHERE a.latitude IS NOT NULL
      AND a.longitude IS NOT NULL
      AND (
        6371 * acos(
          LEAST(
            1,
            GREATEST(
              -1,
              cos(radians($1))
              * cos(radians(a.latitude))
              * cos(radians(a.longitude) - radians($2))
              + sin(radians($1))
              * sin(radians(a.latitude))
            )
          )
        )
      ) <= $3
    LIMIT 1
    `,
    [Number(lat), Number(lng), Number(km)]
  );

  return result.rows.length > 0;
}

async function isAnyPartnerServingPincode(pincode) {
  const pin = String(pincode || '').trim();
  if (!pin) return false;

  const exists = await hasTable('partner_serviceable_pincodes');
  if (!exists) return false;

  const result = await pool.query(
    `
    SELECT 1
    FROM partner_serviceable_pincodes
    WHERE is_active = true
      AND pincode = $1
    LIMIT 1
    `,
    [pin]
  );

  return result.rows.length > 0;
}

router.post("/create", authenticateToken, async (req, res) => {
  try {
    const {
      address,
      city,
      state,
      pincode,
      latitude,
      longitude,
      phone,
      pickupDate,
      timeSlot,
      paymentMethod,
    } = req.body;

    // Serviceability gate (authoritative): validate using customer-entered pincode.
    // This prevents accepting orders just because the customer's live GPS (lat/lon) is near a partner.
    const normalizedPincode = normalizePincode(pincode);
    if (!isValidIndianPincode(normalizedPincode)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PINCODE',
        message: 'Please enter a valid 6-digit pincode.',
      });
    }

    const pinLookup = await lookupByPincode(normalizedPincode);
    if (!pinLookup.ok) {
      return res
        .status(pinLookup.errorType === 'NOT_FOUND' || pinLookup.errorType === 'INVALID_PIN' ? 400 : 503)
        .json({
          success: false,
          code: 'INVALID_PINCODE',
          message:
            pinLookup.errorType === 'NOT_FOUND'
              ? 'Please enter a valid 6-digit pincode.'
              : pinLookup.message || 'PIN Code validation service is unavailable. Please try again.',
        });
    }

    const serviceableByPin = await hasApprovedPartnerForPincode(normalizedPincode);
    if (!serviceableByPin) {
      return res.status(422).json({
        success: false,
        code: "NOT_SERVICEABLE",
        message: "Order not servicable in your region. pls change ur pincode",
      });
    }

    // Location is optional; serviceability is determined by PIN.

    const customerId = req.user.id;

    const addressResult = await pool.query(
      `INSERT INTO customer_addresses
       (customer_id, full_address, city, state, pincode, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        customerId,
        address,
        city || pinLookup.district || '',
        state || pinLookup.state || "",
        normalizedPincode,
        latitude ?? null,
        longitude ?? null,
      ]
    );

    const addressId = addressResult.rows[0].id;

    const orderNumber = `MOB${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // Credits policy (stored per-order):
    // Example target: price ₹40,000 => 4,000 credits required => 20% discount.
    // We persist values so partners see a stable credit requirement.
    await creditService.ensureCreditSchema();
    const orderPrice = Number(phone?.price ?? 0);
    const requiredCredits = orderPrice > 0 ? Math.ceil(orderPrice / 10) : 0;
    const discountPerCredit =
      requiredCredits > 0 ? (0.2 * orderPrice) / requiredCredits : 0;
    const maxDiscountRupees = orderPrice > 0 ? 0.2 * orderPrice : 0;

    const orderResult = await pool.query(
      `INSERT INTO orders
       (customer_id, address_id, phone_model, phone_variant, phone_condition,
        price, pickup_date, payment_method, time_slot, order_number,
        required_credits, discount_rupees_per_credit, max_discount_rupees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        customerId,
        addressId,
        phone.name,
        phone.variant,
        phone.condition,
        phone.price,
        pickupDate,
        paymentMethod,
        timeSlot,
        orderNumber,
        requiredCredits,
        discountPerCredit,
        maxDiscountRupees,
      ]
    );

    res.status(201).json({
      success: true,
      order: orderResult.rows[0],
    });
  } catch (err) {
    console.error("CREATE ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// ASSIGN ORDER TO AGENT
router.patch("/:id/assign", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const agentId = req.user.id;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'in-progress', agent_id = $1
      WHERE id = $2 AND status = 'pending' AND agent_id IS NULL
      RETURNING *
      `,
      [agentId, orderId]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Order already assigned or not available",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (err) {
    console.error("ASSIGN ORDER ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// START PICKUP (for orders already assigned to agent but still pending)
router.patch("/:id/start", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const agentId = req.user.id;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'in-progress'
      WHERE id = $1
        AND agent_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      const check = await pool.query(
        "SELECT id, status, agent_id FROM orders WHERE id = $1",
        [orderId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      const row = check.rows[0];
      if (!row.agent_id) {
        return res.status(409).json({
          success: false,
          message: "Order is not assigned to any agent",
        });
      }
      if (String(row.agent_id) !== String(agentId)) {
        return res.status(409).json({
          success: false,
          message: "Order is assigned to another agent",
        });
      }
      return res.status(409).json({
        success: false,
        message: `Order cannot be started from status '${row.status}'`,
      });
    }

    res.json({
      success: true,
      message: "Pickup started",
      order: result.rows[0],
    });
  } catch (err) {
    console.error("START ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to start pickup",
    });
  }
});

// DECLINE ORDER (unassign a pending order that is currently assigned to this agent)
router.patch("/:id/decline", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const agentId = req.user.id;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'pending',
          agent_id = NULL
      WHERE id = $1
        AND agent_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      const check = await pool.query(
        "SELECT id, status, agent_id FROM orders WHERE id = $1",
        [orderId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      const row = check.rows[0];
      if (!row.agent_id) {
        return res.status(409).json({
          success: false,
          message: "Order is already unassigned",
        });
      }
      if (String(row.agent_id) !== String(agentId)) {
        return res.status(409).json({
          success: false,
          message: "Order is assigned to another agent",
        });
      }
      return res.status(409).json({
        success: false,
        message: `Order cannot be declined from status '${row.status}'`,
      });
    }

    // Track rejected agent for this order (in-memory; no DB changes)
    noteAgentRejected(orderId, agentId);

    res.json({
      success: true,
      message: "Order declined",
      order: result.rows[0],
    });
  } catch (err) {
    console.error("DECLINE ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to decline order",
    });
  }
});

// COMPLETE ORDER
router.patch("/:id/complete", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const agentId = req.user.id;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'completed'
      WHERE id = $1
        AND agent_id = $2
        AND status = 'in-progress'
      RETURNING *
      `,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Order not in progress or not assigned to you",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (err) {
    console.error("COMPLETE ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to complete order",
    });
  }
});

// ❌ CANCEL PICKUP (Return order to Nearby Orders)
router.patch("/:id/cancel", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const agentId = req.user.id;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'pending',
          agent_id = NULL
      WHERE id = $1
        AND agent_id = $2
        AND status = 'in-progress'
      RETURNING *
      `,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Order cannot be cancelled",
      });
    }

    // Treat cancel as a rejection for future assignment attempts
    noteAgentRejected(orderId, agentId);

    res.json({
      success: true,
      message: "Order returned to nearby orders",
      order: result.rows[0],
    });
  } catch (err) {
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ✅ MOVE THIS UP — GET MY ORDERS
router.get("/my", authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.phone_model,
        o.price,
        o.status,
        o.created_at,
        a.name AS agent_name,
        a.phone AS agent_phone
      FROM orders o
      LEFT JOIN agents a ON o.agent_id = a.id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
      `,
      [customerId]
    );

    res.json({
      success: true,
      orders: result.rows,
    });
  } catch (err) {
    console.error("GET MY ORDERS ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

// GET SINGLE ORDER DETAILS — MUST BE LAST
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user.id;
    const userType = req.user.userType;

    let query;
    let params;

    if (userType === "customer") {
      query = `
        SELECT 
          o.*,
          c.name AS customer_name,
          c.phone AS customer_phone,
          c.email AS customer_email,
          ca.full_address,
          ca.city,
          ca.state,
          ca.pincode,
          a.name AS agent_name,
          a.phone AS agent_phone
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN customer_addresses ca ON o.address_id = ca.id
        LEFT JOIN agents a ON o.agent_id = a.id
        WHERE o.id = $1 AND o.customer_id = $2
      `;
      params = [orderId, userId];
    } else {
      query = `
        SELECT 
          o.*,
          c.name AS customer_name,
          c.phone AS customer_phone,
          c.email AS customer_email,
          ca.full_address,
          ca.city,
          ca.state,
          ca.pincode,
          a.name AS agent_name,
          a.phone AS agent_phone
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN customer_addresses ca ON o.address_id = ca.id
        LEFT JOIN agents a ON o.agent_id = a.id
        WHERE o.id = $1 AND (o.agent_id = $2 OR o.status = 'pending')
      `;
      params = [orderId, userId];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (err) {
    console.error("GET ORDER ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch order",
    });
  }
});

module.exports = router;
