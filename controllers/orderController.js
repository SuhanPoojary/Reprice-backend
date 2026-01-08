const { pool } = require("../db");

exports.createOrder = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerId,
      fullName,
      phone,
      email,
      addressLine,
      city,
      state,
      pincode,
      phoneModel,
      variant,
      condition,
      price,
      pickupDate,
      paymentMethod,
    } = req.body;

    await client.query("BEGIN");

    // 1️⃣ Insert address
    const addressResult = await client.query(
      `
      INSERT INTO addresses
      (full_name, phone, email, address_line, city, state, pincode)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id
      `,
      [fullName, phone, email, addressLine, city, state, pincode]
    );

    const addressId = addressResult.rows[0].id;

    // 2️⃣ Insert order
    const orderResult = await client.query(
      `
      INSERT INTO orders
      (customer_id, address_id, phone_model, variant, condition, price, pickup_date, payment_method, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      RETURNING *
      `,
      [
        customerId,
        addressId,
        phoneModel,
        variant,
        condition,
        price,
        pickupDate,
        paymentMethod,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      order: orderResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CREATE ORDER ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Failed to create order",
    });
  } finally {
    client.release();
  }
};
