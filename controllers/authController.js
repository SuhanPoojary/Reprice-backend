const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { query } = require("../db");
const crypto = require("crypto");
const { sendEmail, partnerVerificationEmail } = require("../services/emailService");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

let _partnerSchemaEnsuredPromise = null;

async function ensurePartnerSchema() {
  if (_partnerSchemaEnsuredPromise) return _partnerSchemaEnsuredPromise;

  _partnerSchemaEnsuredPromise = (async () => {
    // Make partner application columns safe even if admin endpoints haven't run yet.
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS company_name text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS business_address text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS gst_number text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS pan_number text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'pending'");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS rejection_reason text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS credit_balance numeric DEFAULT 0");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT false");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()");

    // Email verification flow (before admin review)
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS email_verification_code_hash text");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS email_verification_expires_at timestamptz");
    await query("ALTER TABLE partners ADD COLUMN IF NOT EXISTS email_verified_at timestamptz");

    await query(`
      CREATE TABLE IF NOT EXISTS partner_verification_history (
        id bigserial PRIMARY KEY,
        partner_id text NOT NULL,
        action_type text NOT NULL,
        message_from_admin text,
        message_from_partner text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

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
      "CREATE INDEX IF NOT EXISTS idx_partner_verification_history_partner_id_created_at ON partner_verification_history (partner_id, created_at DESC)"
    );
    await query(
      "CREATE INDEX IF NOT EXISTS idx_partner_serviceable_pincodes_partner_id ON partner_serviceable_pincodes (partner_id)"
    );
  })();

  return _partnerSchemaEnsuredPromise;
}

function _generateEmailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function _hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function _emailCodeExpiresAt() {
  const mins = Number(process.env.PARTNER_EMAIL_CODE_TTL_MINUTES || 10);
  const ms = (Number.isFinite(mins) ? mins : 10) * 60_000;
  return new Date(Date.now() + ms);
}

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
  const pincode = src.pincode ?? src.serviceable_pincode ?? src.serviceablePincode;

  return {
    company_name: companyName ? String(companyName).trim() : null,
    business_address: businessAddress ? String(businessAddress).trim() : null,
    gst_number: gstNumber ? String(gstNumber).trim() : null,
    pan_number: panNumber ? String(panNumber).trim() : null,
    message_from_partner: messageFromPartner ? String(messageFromPartner).trim() : null,
    pincode: pincode ? String(pincode).trim() : null,
  };
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

    if (userType === "partner") {
      await ensurePartnerSchema();
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
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'email_pending',false)
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
      // Email verification: generate + store code hash, then send email.
      const code = _generateEmailCode();
      const codeHash = _hashCode(code);
      const expiresAt = _emailCodeExpiresAt();

      await query(
        `
        UPDATE partners
        SET email_verification_code_hash = $2,
            email_verification_expires_at = $3,
            email_verified_at = NULL
        WHERE id::text = $1
        `,
        [String(user.id), codeHash, expiresAt]
      );

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

      // Best-effort: send email (do not fail signup if SMTP isn't configured)
      try {
        const payload = partnerVerificationEmail({
          to: String(email),
          name: String(name || ""),
          code,
        });
        await sendEmail({ to: String(email), ...payload });
        await query(
          `INSERT INTO partner_verification_history (partner_id, action_type, message_from_admin)
           VALUES ($1, 'email_code_sent', 'Verification code sent to partner email')`,
          [String(user.id)]
        );
      } catch (e) {
        console.error("PARTNER VERIFICATION EMAIL SEND ERROR:", e);
      }

      // Best-effort: store a first serviceable pincode from the application.
      try {
        if (partnerFields?.pincode) {
          await query(
            `
            INSERT INTO partner_serviceable_pincodes (partner_id, pincode, is_active)
            VALUES ($1, $2, true)
            `,
            [String(user.id), String(partnerFields.pincode)]
          );
        }
      } catch {
        // ignore
      }

      // Partner signup requires email verification before admin review.
      return res.status(201).json({
        success: true,
        message:
          "Verification code sent to your email. Please verify to submit your application for admin review.",
        data: {
          application_submitted: true,
          partner_id: String(user.id),
          email_verification_required: true,
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

exports.verifyPartnerEmail = async (req, res) => {
  try {
    await ensurePartnerSchema();

    const partnerId = String(req.body?.partner_id ?? "").trim();
    const code = String(req.body?.code ?? "").trim();

    if (!partnerId || !code) {
      return res.status(400).json({ success: false, message: "partner_id and code are required" });
    }

    const result = await query(
      `
      SELECT id, email_verification_code_hash, email_verification_expires_at
      FROM partners
      WHERE id::text = $1
      LIMIT 1
      `,
      [partnerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    const row = result.rows[0];
    const hash = row.email_verification_code_hash;
    const expiresAt = row.email_verification_expires_at ? new Date(row.email_verification_expires_at) : null;

    if (!hash) {
      return res.status(400).json({ success: false, message: "No active verification code. Please sign up again." });
    }

    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return res.status(410).json({ success: false, message: "Verification code expired. Please sign up again." });
    }

    if (_hashCode(code) !== String(hash)) {
      return res.status(401).json({ success: false, message: "Invalid verification code" });
    }

    await query(
      `
      UPDATE partners
      SET email_verified_at = now(),
          email_verification_code_hash = NULL,
          email_verification_expires_at = NULL,
          verification_status = 'pending',
          is_active = false
      WHERE id::text = $1
      `,
      [partnerId]
    );

    // Best-effort timeline event
    try {
      await query(
        `INSERT INTO partner_verification_history (partner_id, action_type, message_from_partner)
         VALUES ($1, 'email_verified', 'Partner verified email')`,
        [partnerId]
      );
    } catch {
      // ignore
    }

    return res.json({ success: true, message: "Email verified. Your application is now pending admin review." });
  } catch (err) {
    console.error("VERIFY PARTNER EMAIL ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to verify email" });
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
            verificationStatus === "email_pending"
              ? "Please verify your email to submit your application."
              :
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

