const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../db");

// Helper function to generate JWT token
const generateToken = (user, userType) => {
  return jwt.sign(
    { id: user.id, phone: user.phone, userType },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

exports.signup = async (req, res) => {
  const { name, phone, email, password, userType } = req.body;

  try {
    if (!name || !phone || !password || !userType) {
      return res.status(400).json({
        success: false,
        message: "Name, phone, password, and user type are required",
      });
    }

    if (!["customer", "agent"].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user type. Must be "customer" or "agent"',
      });
    }

    const table = userType === "customer" ? "customers" : "agents";

    const existingUser = await query(
      `SELECT id FROM ${table} WHERE phone = $1`,
      [phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User with this phone already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO ${table} (name, phone, email, password_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, phone, email`,
      [name, phone, email || null, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user, userType);

    res.status(201).json({
      success: true,
      data: { user: { ...user, userType }, token },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false });
  }
};

exports.login = async (req, res) => {
  const { phone, password, userType } = req.body;

  try {
    const table = userType === "customer" ? "customers" : "agents";

    const result = await query(
      `SELECT * FROM ${table} WHERE phone = $1`,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false });
    }

    const token = generateToken(user, userType);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          userType,
        },
        token,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false });
  }
};

exports.getCurrentUser = async (req, res) => {
  const { id, userType } = req.user;
  const table = userType === "customer" ? "customers" : "agents";

  const result = await query(
    `SELECT id, name, phone, email FROM ${table} WHERE id = $1`,
    [id]
  );

  res.json({
    success: true,
    data: { ...result.rows[0], userType },
  });
};

exports.logout = async (req, res) => {
  res.json({ success: true });
};
