const express = require('express');
const router = express.Router();

const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { authenticateToken, isPartner } = require('../middleware/authMiddleware');
const { getRejectedAgentIds, getReturnedAt } = require('../memory/orderMemory');
const creditService = require('../services/creditService');

const _columnCache = new Map();

async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_columnCache.has(key)) return _columnCache.get(key);

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
  _columnCache.set(key, exists);
  return exists;
}

router.use(authenticateToken, isPartner);

// List all orders with agents assigned (orders being managed)
router.get('/orders', async (req, res) => {
  try {
    await creditService.ensureCreditSchema();
    const partnerId = String(req.user.id);
    const hasPartnerId = await hasColumn('agents', 'partner_id');

    // If agents.partner_id exists, scope assigned orders to this partner's agents.
    // Also include orders this partner has accepted (orders.partner_id = partnerId), even if not yet assigned.
    const assignedFilter = hasPartnerId
      ? '(o.agent_id IS NOT NULL AND a.partner_id = $1)'
      : '(o.agent_id IS NOT NULL)';

    const whereClause = `WHERE (${assignedFilter} OR (o.partner_id::text = $1))`;

    const params = [partnerId];

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.phone_model,
        o.phone_variant,
        o.phone_condition,
        o.price,
        o.status,
        o.pickup_date,
        o.time_slot,
        o.created_at,
        o.agent_id,
        o.partner_id,
        o.credits_charged,
        CASE WHEN o.partner_id::text = $1 THEN TRUE ELSE FALSE END AS partner_accepted,

        c.name AS customer_name,
        c.phone AS customer_phone,

        ca.full_address,
        ca.city,
        ca.state,
        ca.pincode,
        ca.latitude,
        ca.longitude,

        a.name AS agent_name,
        a.phone AS agent_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN customer_addresses ca ON o.address_id = ca.id
      LEFT JOIN agents a ON o.agent_id = a.id
      ${whereClause}
      ORDER BY o.created_at DESC
      `
      ,
      params
    );

    const orders = await Promise.all(
      result.rows.map(async (o) => {
        const cost = await creditService.getCreditCostForOrder(o);
        return {
          ...o,
          required_credits: cost.credits_required,
          credit_product_key: cost.product_key,
          blocked_agent_ids: getRejectedAgentIds(o.id),
          returned_at: getReturnedAt(o.id),
        };
      })
    );

    res.json({ success: true, orders });
  } catch (err) {
    console.error('PARTNER LIST ORDERS ERROR:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

// List unassigned orders available for partners to accept (pending, no agent)
router.get('/orders/available', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.phone_model,
        o.phone_variant,
        o.phone_condition,
        o.price,
        o.status,
        o.pickup_date,
        o.time_slot,
        o.created_at,
        o.agent_id,
        FALSE AS partner_accepted,

        c.name AS customer_name,
        c.phone AS customer_phone,

        ca.full_address,
        ca.city,
        ca.state,
        ca.pincode,
        ca.latitude,
        ca.longitude,

        a.name AS agent_name,
        a.phone AS agent_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN customer_addresses ca ON o.address_id = ca.id
      LEFT JOIN agents a ON o.agent_id = a.id
      WHERE o.status = 'pending'
        AND o.agent_id IS NULL
        AND (o.partner_id IS NULL OR o.partner_id = '')
      ORDER BY o.created_at DESC
      `
    );

    const orders = await Promise.all(
      result.rows.map(async (o) => {
        const cost = await creditService.getCreditCostForOrder(o);
        return {
          ...o,
          required_credits: cost.credits_required,
          credit_product_key: cost.product_key,
          blocked_agent_ids: getRejectedAgentIds(o.id),
          returned_at: getReturnedAt(o.id),
        };
      })
    );

    res.json({ success: true, orders });
  } catch (err) {
    console.error('PARTNER LIST AVAILABLE ORDERS ERROR:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch available orders' });
  }
});

// List agents for partner view
router.get('/agents', async (req, res) => {
  try {
    const [hasLat, hasLng, hasLastSeen] = await Promise.all([
      hasColumn('agents', 'latitude'),
      hasColumn('agents', 'longitude'),
      hasColumn('agents', 'last_seen_at'),
    ]);

    const hasPartnerId = await hasColumn('agents', 'partner_id');

    const latSelect = hasLat ? 'latitude' : 'NULL::double precision AS latitude';
    const lngSelect = hasLng ? 'longitude' : 'NULL::double precision AS longitude';
    const lastSeenSelect = hasLastSeen ? 'last_seen_at' : 'NULL::timestamptz AS last_seen_at';

    const partnerSelect = hasPartnerId ? 'partner_id' : 'NULL::uuid AS partner_id';
    const whereClause = hasPartnerId ? 'WHERE partner_id = $1' : '';

    const params = hasPartnerId ? [req.user.id] : [];

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        phone,
        email,
        ${latSelect},
        ${lngSelect},
        ${lastSeenSelect},
        ${partnerSelect}
      FROM agents
      ${whereClause}
      ORDER BY name ASC
      `
      ,
      params
    );

    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error('PARTNER LIST AGENTS ERROR:', err);
    const details = String(err?.message ?? err);
    res.status(500).json({
      success: false,
      message:
        process.env.NODE_ENV !== 'production'
          ? `Failed to fetch agents: ${details}`
          : 'Failed to fetch agents',
    });
  }
});

// Create an agent under this partner
router.post('/agents', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body ?? {};

    if (!name || !password) {
      return res.status(400).json({ success: false, message: 'name and password are required' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const hasPartnerId = await hasColumn('agents', 'partner_id');

    const columns = ['name', 'phone', 'email', 'password_hash'];
    const values = [name, phone ?? null, email ?? null, passwordHash];
    if (hasPartnerId) {
      columns.push('partner_id');
      values.push(req.user.id);
    }

    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');

    const result = await pool.query(
      `
      INSERT INTO agents (${columns.join(',')})
      VALUES (${placeholders})
      RETURNING id, name, phone, email, latitude, longitude, last_seen_at${hasPartnerId ? ', partner_id' : ''}
      `,
      values
    );

    res.status(201).json({ success: true, agent: result.rows[0] });
  } catch (err) {
    console.error('PARTNER CREATE AGENT ERROR:', err);
    const details = String(err?.message ?? err);
    res.status(500).json({
      success: false,
      message:
        process.env.NODE_ENV !== 'production'
          ? `Failed to create agent: ${details}`
          : 'Failed to create agent',
    });
  }
});

// Accept an order (partner action - marks status as 'accepted' in memory)
// Note: This doesn't persist to DB, just tracks acceptance in session
router.patch('/orders/:id/accept', async (req, res) => {
  try {
    const orderId = req.params.id;

    await creditService.ensureCreditSchema();

    const partnerId = String(req.user.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the order so only one partner can accept it.
      const orderRes = await client.query(
        `
        SELECT *
        FROM orders
        WHERE id::text = $1
        FOR UPDATE
        `,
        [String(orderId)]
      );

      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      const order = orderRes.rows[0];

      if (order.partner_id && String(order.partner_id) !== partnerId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Order already accepted by another partner' });
      }

      if (order.status !== 'pending' || order.agent_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Order is not available to accept' });
      }

      const { credits_required, product_key } = await creditService.getCreditCostForOrder(order);

      try {
        await creditService.deductCredits({
          partnerId,
          credits: credits_required,
          referenceType: 'order_accept',
          referenceId: String(orderId),
          message: `Accepted order ${order.order_number || orderId}`,
          metadata: { product_key, credits_required },
          client,
        });
      } catch (e) {
        if (e?.code === 'INSUFFICIENT_CREDITS') {
          await client.query('ROLLBACK');
          return res.status(402).json({
            success: false,
            message: 'Insufficient Credits',
            required_credits: credits_required,
            balance: e.balance,
            product_key,
          });
        }
        throw e;
      }

      const updated = await client.query(
        `
        UPDATE orders
        SET partner_id = $2,
            credits_charged = $3
        WHERE id::text = $1
        RETURNING *
        `,
        [String(orderId), partnerId, Number(credits_required)]
      );

      await client.query('COMMIT');

      return res.json({
        success: true,
        order: updated.rows[0],
        required_credits: credits_required,
        credit_product_key: product_key,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('PARTNER ACCEPT ORDER ERROR:', err);
    res.status(500).json({ success: false, message: 'Failed to accept order' });
  }
});

// Assign an order to an agent (partner action)
router.patch('/orders/:id/assign-agent', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, message: 'agentId is required' });
    }

    // Ensure agent exists
    const agent = await pool.query('SELECT id FROM agents WHERE id = $1', [agentId]);
    if (agent.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET agent_id = $1
      WHERE id = $2
        AND status = 'pending'
        AND agent_id IS NULL
        AND partner_id::text = $3
      RETURNING *
      `,
      [agentId, orderId, String(req.user.id)]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'Order already assigned, not accepted by you, or not available' });
    }

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error('PARTNER ASSIGN ORDER ERROR:', err);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

module.exports = router;
