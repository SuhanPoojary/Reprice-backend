const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { query } = require("../db");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

    if (!["customer", "agent", "partner"].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user type. Must be "customer", "agent" or "partner"',
      });
    }

    const table = userType === "customer" ? "customers" : userType === "agent" ? "agents" : "partners";

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
    if (!["customer", "agent", "partner"].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user type. Must be "customer", "agent" or "partner"',
      });
    }

    const table = userType === "customer" ? "customers" : userType === "agent" ? "agents" : "partners";

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

// Google OAuth Login/Signup
exports.googleAuth = async (req, res) => {
  const { userType } = req.body;
  const idToken = req.body.credential || req.body.token || req.body.idToken;

  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        success: false,
        message: "Server misconfigured: GOOGLE_CLIENT_ID missing",
      });
    }

    if (!idToken || !userType) {
      return res.status(400).json({
        success: false,
        message: "credential (Google ID token) and userType are required",
      });
    }

    if (!["customer", "agent", "partner"].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user type. Must be "customer", "agent" or "partner"',
      });
    }

    // Verify the Google token (ID token)
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload?.email;
    const name = payload?.name;
    const googleId = payload?.sub;

    if (!email) {
      return res.status(401).json({
        success: false,
        message: "Invalid Google token (missing email)",
      });
    }

    const table = userType === "customer" ? "customers" : userType === "agent" ? "agents" : "partners";

    // Check whether google_id column exists (avoid crashing on schema mismatch)
    const googleIdCol = await query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'google_id' LIMIT 1",
      [table]
    );
    const hasGoogleIdColumn = googleIdCol.rows.length > 0;

    // Find existing user by email
    const userResult = await query(`SELECT * FROM ${table} WHERE email = $1`, [
      email,
    ]);

    let user;
    if (userResult.rows.length === 0) {
      // Create new user
      const displayName = name || "User";

      const insertWithPhone = async (phoneValue) => {
        if (hasGoogleIdColumn) {
          return query(
            `INSERT INTO ${table} (name, phone, email, password_hash, google_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, phone, email`,
            [displayName, phoneValue, email, "google_auth", googleId]
          );
        }

        return query(
          `INSERT INTO ${table} (name, phone, email, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, phone, email`,
          [displayName, phoneValue, email, "google_auth"]
        );
      };

      try {
        const inserted = await insertWithPhone(null);
        user = inserted.rows[0];
      } catch (dbErr) {
        // If phone is NOT NULL in DB schema, fall back to a synthetic placeholder.
        const isPhoneNotNullViolation =
          typeof dbErr?.message === "string" &&
          dbErr.message.toLowerCase().includes("phone") &&
          dbErr.message.toLowerCase().includes("null");

        if (!isPhoneNotNullViolation) {
          throw dbErr;
        }

        const placeholderPhone = `google-${(googleId || Date.now().toString()).slice(-12)}`;
        const inserted = await insertWithPhone(placeholderPhone);
        user = inserted.rows[0];
      }
    } else {
      user = userResult.rows[0];

      // Best-effort: store google_id for existing users if the column exists.
      if (hasGoogleIdColumn && googleId && !user.google_id) {
        try {
          await query(`UPDATE ${table} SET google_id = $1 WHERE id = $2`, [
            googleId,
            user.id,
          ]);
        } catch {
          // Ignore; login should still succeed.
        }
      }
    }

    const jwtToken = generateToken(user, userType);
    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          userType,
        },
        token: jwtToken,
      },
    });
  } catch (err) {
    // Token verification issues should be 401; DB issues should be 500.
    const isGoogleTokenError =
      typeof err?.message === "string" &&
      (err.message.includes("Wrong recipient") ||
        err.message.includes("audience") ||
        err.message.toLowerCase().includes("invalid") ||
        err.message.toLowerCase().includes("token"));

    const status = err?.code ? 500 : isGoogleTokenError ? 401 : 500;

    console.error("Google auth error:", err);
    return res.status(status).json({
      success: false,
      message:
        status === 401
          ? "Invalid Google token"
          : "Server error during Google login",
      error: err?.message,
    });
  }
};

exports.getCurrentUser = async (req, res) => {
  const { id, userType } = req.user;
  const table = userType === "customer" ? "customers" : userType === "agent" ? "agents" : "partners";

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

