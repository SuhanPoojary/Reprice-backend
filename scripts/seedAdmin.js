/*
  Seeds (or updates) a Neon/Postgres admin user.

  Usage:
    - Set DATABASE_URL, JWT_SECRET (not used here), and admin vars in Reprice-backend/.env
    - Run: node scripts/seedAdmin.js

  Env:
    ADMIN_EMAIL (required)
    ADMIN_PASSWORD (required unless ADMIN_PASSWORD_HASH is provided)
    ADMIN_PASSWORD_HASH (optional)
    ADMIN_FULL_NAME (optional)
    ADMIN_ROLE (optional)
*/

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");

async function ensureAdminsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id bigserial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      full_name text,
      role text NOT NULL DEFAULT 'super_admin',
      password_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admins_email_lower ON admins (lower(email))"
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

  const email = String(process.env.ADMIN_EMAIL || "").trim();
  const fullName = String(process.env.ADMIN_FULL_NAME || "Admin").trim();
  const role = String(process.env.ADMIN_ROLE || "super_admin").trim();
  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!email) throw new Error("ADMIN_EMAIL is required");
  if (!password && !passwordHash) {
    throw new Error("Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH");
  }

  await ensureAdminsTable();

  const computedHash = passwordHash
    ? String(passwordHash)
    : await bcrypt.hash(String(password), 10);

  const result = await pool.query(
    `
    INSERT INTO admins (email, full_name, role, password_hash, is_active)
    VALUES ($1, $2, $3, $4, true)
    ON CONFLICT (email) DO UPDATE
      SET full_name = EXCLUDED.full_name,
          role = EXCLUDED.role,
          password_hash = EXCLUDED.password_hash,
          is_active = true
    RETURNING id, email, full_name, role, is_active
    `,
    [email, fullName, role, computedHash]
  );

  console.log("✅ Seeded admin:", result.rows[0]);
}

main()
  .catch((err) => {
    console.error("❌ Seed admin failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  });
