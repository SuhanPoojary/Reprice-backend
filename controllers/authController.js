const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { query } = require("../db");
const { lookupByPincode, normalizePincode } = require("../services/indiaPostService");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper function to generate JWT token
const generateToken = (user, userType) => {
  return jwt.sign(
    { id: user.id, phone: user.phone, userType },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

function getPartnerApplicationFields(body) {
  const src = body ?? {};

  const companyName = src.company_name ?? src.companyName;
  const businessAddress = src.business_address ?? src.businessAddress;
  const gstNumber = src.gst_number ?? src.gstNumber;
  const panNumber = src.pan_number ?? src.panNumber;
  const messageFromPartner = src.message_from_partner ?? src.messageFromPartner;
  const pincode = src.pincode ?? src.service_pincode ?? src.servicePincode;

  return {
    company_name: companyName ? String(companyName).trim() : null,
    business_address: businessAddress ? String(businessAddress).trim() : null,
    pincode: pincode ? String(pincode).trim() : null,
    gst_number: gstNumber ? String(gstNumber).trim() : null,
    pan_number: panNumber ? String(panNumber).trim() : null,
    message_from_partner: messageFromPartner ? String(messageFromPartner).trim() : null,
  };
}

async function ensurePartnerServiceablePincodesSchema() {
  // Keep this idempotent; partner signup may run before admin has ever opened the dashboard.
  await query(`
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

  await query(
    "CREATE INDEX IF NOT EXISTS idx_partner_serviceable_pincodes_partner_id ON partner_serviceable_pincodes (partner_id)",
    []
  );
  await query(
    "CREATE INDEX IF NOT EXISTS idx_partner_serviceable_pincodes_pincode_active ON partner_serviceable_pincodes (pincode, is_active)",
    []
  );
}

function shapeUserForResponse(userType, row) {
  const base = {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    userType,
  };

  if (userType !== "partner") return base;

  return {
    ...base,
    company_name: row.company_name ?? null,
    business_address: row.business_address ?? null,
    gst_number: row.gst_number ?? null,
    pan_number: row.pan_number ?? null,
    verification_status: row.verification_status ?? null,
    is_active: row.is_active ?? null,
    rejection_reason: row.rejection_reason ?? null,
  };
}

exports.signup = async (req, res) => {
  const { name, phone, email, password, userType } = req.body;

  try {
    if (!name || !phone || !password || !userType) {
      return res.status(400).json({
        success: false,
        message: "Name, phone, password, and user type are required",
      });
    }

    if (userType === "partner" && !String(email || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Email is required for partner applications",
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

    const partnerFields = userType === "partner" ? getPartnerApplicationFields(req.body) : null;

    if (userType === 'partner') {
      const pin = partnerFields?.pincode ? normalizePincode(partnerFields.pincode) : '';
      if (!pin) {
        return res.status(400).json({ success: false, message: 'Service pincode is required' });
      }
      const pinLookup = await lookupByPincode(pin);
      if (!pinLookup.ok) {
        return res.status(pinLookup.errorType === 'NOT_FOUND' || pinLookup.errorType === 'INVALID_PIN' ? 400 : 503).json({
          success: false,
          message:
            pinLookup.errorType === 'NOT_FOUND'
              ? 'Please enter a valid 6-digit pincode.'
              : pinLookup.message || 'PIN Code validation service is unavailable. Please try again.',
        });
      }

      // Store back normalized pin (digits only) so DB matches order pincodes.
      partnerFields.pincode = pin;
    }

    const result =
      userType === "partner"
        ? await query(
            `INSERT INTO ${table} (
              name,
              phone,
              email,
              password_hash,
              company_name,
              business_address,
              gst_number,
              pan_number,
              verification_status,
              is_active
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',false)
            RETURNING id, name, phone, email, company_name, business_address, gst_number, pan_number, verification_status, is_active, rejection_reason`,
            [
              name,
              phone,
              email || null,
              passwordHash,
              partnerFields.company_name,
              partnerFields.business_address,
              partnerFields.gst_number,
              partnerFields.pan_number,
            ]
          )
        : await query(
            `INSERT INTO ${table} (name, phone, email, password_hash)
             VALUES ($1,$2,$3,$4)
             RETURNING id, name, phone, email`,
            [name, phone, email || null, passwordHash]
          );

    const user = result.rows[0];

    if (userType === "partner") {
      // Best-effort: store partner's service pincode for serviceability checks.
      try {
        const pin = partnerFields?.pincode ? normalizePincode(partnerFields.pincode) : "";
        if (pin) {
          await ensurePartnerServiceablePincodesSchema();
          await query(
            `INSERT INTO partner_serviceable_pincodes (partner_id, pincode, is_active)
             VALUES ($1, $2, true)`,
            [String(user.id), pin]
          );
        }
      } catch {
        // ignore
      }

      // Best-effort: record application submission event for admin timeline.
      try {
        const message = partnerFields?.message_from_partner || "Application submitted";
        await query(
          `INSERT INTO partner_verification_history (partner_id, action_type, message_from_partner)
           VALUES ($1, 'submitted', $2)`,
          [String(user.id), message]
        );
      } catch {
        // ignore
      }

      // Partner signup is an application submission (no login until admin approves).
      return res.status(201).json({
        success: true,
        message:
          "Application submitted. Admin will review and contact you via email if approved.",
        data: {
          application_submitted: true,
          partner_id: String(user.id),
        },
      });
    }

    const token = generateToken(user, userType);

    res.status(201).json({
      success: true,
      data: { user: shapeUserForResponse(userType, user), token },
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

    const result = await query(`SELECT * FROM ${table} WHERE phone = $1`, [phone]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false });
    }

    if (userType === "partner") {
      const verificationStatus = String(user.verification_status || "pending").toLowerCase();
      const isActive = user.is_active === true;

      if (!isActive || verificationStatus !== "approved") {
        return res.status(403).json({
          success: false,
          code: "PARTNER_NOT_APPROVED",
          message:
            verificationStatus === "rejected"
              ? "Your application was rejected"
              : verificationStatus === "clarification" || verificationStatus === "clarification_needed"
                ? "Your application needs clarification. Please check your email."
                : "Your application is pending admin approval. Please wait for approval email.",
          verification_status: verificationStatus,
          is_active: isActive,
          rejection_reason: user.rejection_reason ?? null,
        });
      }
    }

    const token = generateToken(user, userType);

    res.json({
      success: true,
      data: {
        user: shapeUserForResponse(userType, user),
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

    // Partners must go through manual application + approval.
    if (String(userType) === "partner") {
      return res.status(400).json({
        success: false,
        message: "Google login is not supported for partners. Please submit an application.",
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

  const result =
    userType === "partner"
      ? await query(
          `SELECT id, name, phone, email, company_name, business_address, gst_number, pan_number, verification_status, rejection_reason, is_active FROM ${table} WHERE id = $1`,
          [id]
        )
      : await query(`SELECT id, name, phone, email FROM ${table} WHERE id = $1`, [id]);

  res.json({
    success: true,
    data: shapeUserForResponse(userType, result.rows[0] || {}),
  });
};


exports.logout = async (req, res) => {
  res.json({ success: true });
};

