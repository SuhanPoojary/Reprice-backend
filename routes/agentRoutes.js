const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { authenticateToken } = require("../middleware/authMiddleware");

/**
 * GET NEARBY ORDERS (within 20 km)
 */
router.get("/nearby-orders", authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;

    // 1️⃣ Get agent location
    const agentResult = await pool.query(
      "SELECT latitude, longitude FROM agents WHERE id = $1",
      [agentId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Agent not found",
      });
    }

    const { latitude, longitude } = agentResult.rows[0];

    // 2️⃣ Validate location
    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "Agent location not set",
      });
    }

    // 3️⃣ Distance-based query
   const ordersResult = await pool.query(
  `
  SELECT
    sub.id,
    sub.phone_model,
    sub.phone_variant,
    sub.phone_condition,
    sub.price,
    sub.status,
    sub.pickup_date,
    sub.time_slot, 

    sub.customer_name,
    sub.customer_phone,

    sub.full_address,
    sub.city,
    sub.pincode,
    sub.latitude,
    sub.longitude,
    sub.distance_km

  FROM (
    SELECT 
      o.id,
      o.phone_model,
      o.phone_variant,
      o.phone_condition,
      o.price,
      o.status,
      o.pickup_date,
      o.time_slot,

      c.name AS customer_name,
      c.phone AS customer_phone,

      ca.full_address,
      ca.city,
      ca.pincode,
      ca.latitude,
      ca.longitude,

      (
        6371 * acos(
          cos(radians($1))
          * cos(radians(ca.latitude))
          * cos(radians(ca.longitude) - radians($2))
          + sin(radians($1))
          * sin(radians(ca.latitude))
        )
      ) AS distance_km

    FROM orders o
    INNER JOIN customers c ON o.customer_id = c.id
    INNER JOIN customer_addresses ca ON o.address_id = ca.id
    WHERE o.status = 'pending'
      AND o.agent_id IS NULL
  ) AS sub
  WHERE sub.distance_km <= 20
  ORDER BY sub.distance_km ASC
  `,
  [latitude, longitude]
);



    res.json({
      success: true,
      orders: ordersResult.rows,
    });
  } catch (err) {
    console.error("NEARBY ORDERS ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

/**
 * GET MY PICKUPS (assigned to logged-in agent)
 */
router.get("/my-pickups", authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;

    const result = await pool.query(
      `
      SELECT 
        o.id,
        o.phone_model,
        o.phone_variant,
        o.phone_condition,
        o.price,
        o.status,
        o.time_slot,

        o.pickup_date,

        c.name AS customer_name,
        c.phone AS customer_phone,

        ca.full_address,
        ca.city,
        ca.pincode,
        ca.latitude,        
        ca.longitude
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN customer_addresses ca ON o.address_id = ca.id
      WHERE o.agent_id = $1
      ORDER BY o.pickup_date ASC
      `,
      [agentId]
    );

    res.json({
      success: true,
      orders: result.rows,
    });
  } catch (err) {
    console.error("MY PICKUPS ERROR:", err);
    res.status(500).json({ success: false });
  }
});


router.post("/update-location", authenticateToken, async (req, res) => {
  const { latitude, longitude } = req.body;

  // 1️⃣ Validate input
  if (!latitude || !longitude) {
    return res.status(400).json({
      success: false,
      message: "Latitude and longitude are required",
    });
  }

  // 2️⃣ Update agent location
  await pool.query(
    "UPDATE agents SET latitude=$1, longitude=$2 WHERE id=$3",
    [latitude, longitude, req.user.id]
  );

  res.json({
    success: true,
    message: "Location updated successfully",
  });
});

router.get("/my-orders", authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;

    const result = await pool.query(
      `
      SELECT 
        o.id,
        o.phone_model,
        o.phone_variant,
        o.phone_condition,
        o.price,
        o.status,
        o.time_slot,

        o.pickup_date,

        c.name AS customer_name,
        ca.full_address
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN customer_addresses ca ON o.address_id = ca.id
      WHERE o.agent_id = $1
      ORDER BY o.pickup_date ASC
      `,
      [agentId]
    );

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
