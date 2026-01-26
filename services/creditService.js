const { pool } = require("../db");

let _schemaEnsuredPromise = null;

async function ensureCreditSchema() {
  if (_schemaEnsuredPromise) return _schemaEnsuredPromise;

  _schemaEnsuredPromise = (async () => {
    // Partner balance (denormalized)
    await pool.query(
      "ALTER TABLE partners ADD COLUMN IF NOT EXISTS credit_balance numeric DEFAULT 0"
    );

    // Locking + attribution on orders (idempotent)
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_id text");
    await pool.query(
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_charged integer DEFAULT 0"
    );

    // Ledger
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id bigserial PRIMARY KEY,
        partner_id text NOT NULL,
        txn_type text NOT NULL, -- earn | spend | adjust
        delta_credits numeric NOT NULL,
        balance_after numeric NOT NULL,
        reference_type text,
        reference_id text,
        message text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await pool.query(
      "CREATE INDEX IF NOT EXISTS credit_transactions_partner_id_idx ON credit_transactions(partner_id)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS credit_transactions_created_at_idx ON credit_transactions(created_at DESC)"
    );

    // Product/order credit costs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_credit_costs (
        product_key text PRIMARY KEY,
        credits_per_order integer NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Ensure a default cost exists
    await pool.query(
      `INSERT INTO product_credit_costs (product_key, credits_per_order, is_active)
       VALUES ('default', 0, true)
       ON CONFLICT (product_key) DO NOTHING`
    );

    // Plan purchases history (optional, but useful)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plan_purchases (
        id bigserial PRIMARY KEY,
        partner_id text NOT NULL,
        plan_id bigint NOT NULL,
        credits_granted numeric NOT NULL,
        price numeric,
        payment_reference text,
        metadata jsonb,
        purchased_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await pool.query(
      "CREATE INDEX IF NOT EXISTS plan_purchases_partner_id_idx ON plan_purchases(partner_id)"
    );
  })();

  return _schemaEnsuredPromise;
}

function pickProductKeyFromOrder(orderRow) {
  // Most flexible: admin can configure any key. We try a few candidates.
  return (
    orderRow?.product_type ||
    orderRow?.phone_model ||
    orderRow?.phone_condition ||
    "default"
  );
}

async function getCreditCostForOrder(orderRow) {
  await ensureCreditSchema();

  const productKey = pickProductKeyFromOrder(orderRow);

  const costResult = await pool.query(
    `
    SELECT credits_per_order
    FROM product_credit_costs
    WHERE product_key = $1 AND is_active = true
    LIMIT 1
    `,
    [String(productKey)]
  );

  if (costResult.rows.length > 0) {
    return { product_key: productKey, credits_required: Number(costResult.rows[0].credits_per_order) };
  }

  // fallback to default
  const fallback = await pool.query(
    `SELECT credits_per_order FROM product_credit_costs WHERE product_key = 'default' LIMIT 1`
  );

  return {
    product_key: "default",
    credits_required: Number(fallback.rows[0]?.credits_per_order ?? 0),
  };
}

async function getPartnerBalance(partnerId) {
  await ensureCreditSchema();
  const r = await pool.query(
    "SELECT COALESCE(credit_balance,0) AS credit_balance FROM partners WHERE id::text = $1 LIMIT 1",
    [String(partnerId)]
  );
  if (r.rows.length === 0) return null;
  return Number(r.rows[0].credit_balance ?? 0);
}

async function applyCreditDelta({
  partnerId,
  delta,
  txnType,
  referenceType,
  referenceId,
  message,
  metadata,
  client,
}) {
  const db = client || pool;

  // Lock partner row so balance cannot race.
  const row = await db.query(
    "SELECT id, COALESCE(credit_balance,0) AS credit_balance FROM partners WHERE id::text = $1 FOR UPDATE",
    [String(partnerId)]
  );

  if (row.rows.length === 0) {
    const err = new Error("Partner not found");
    err.code = "PARTNER_NOT_FOUND";
    throw err;
  }

  const current = Number(row.rows[0].credit_balance ?? 0);
  const next = current + Number(delta);

  if (next < 0) {
    const err = new Error("Insufficient Credits");
    err.code = "INSUFFICIENT_CREDITS";
    err.balance = current;
    err.required = Math.abs(Number(delta));
    throw err;
  }

  await db.query(
    "UPDATE partners SET credit_balance = $2 WHERE id::text = $1",
    [String(partnerId), next]
  );

  await db.query(
    `
    INSERT INTO credit_transactions
      (partner_id, txn_type, delta_credits, balance_after, reference_type, reference_id, message, metadata)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      String(partnerId),
      String(txnType),
      Number(delta),
      next,
      referenceType ?? null,
      referenceId ?? null,
      message ?? null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );

  return { balance: next };
}

async function addCredits({ partnerId, credits, referenceType, referenceId, message, metadata, client }) {
  return applyCreditDelta({
    partnerId,
    delta: Number(credits),
    txnType: "earn",
    referenceType,
    referenceId,
    message,
    metadata,
    client,
  });
}

async function deductCredits({ partnerId, credits, referenceType, referenceId, message, metadata, client }) {
  return applyCreditDelta({
    partnerId,
    delta: -Math.abs(Number(credits)),
    txnType: "spend",
    referenceType,
    referenceId,
    message,
    metadata,
    client,
  });
}

async function purchasePlan({ partnerId, planId, paymentReference }) {
  await ensureCreditSchema();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // credit_plans is created by admin schema; but ensure it exists.
    await client.query(`
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

    const planRes = await client.query(
      `
      SELECT id, plan_name, credit_amount, price, bonus_percentage
      FROM credit_plans
      WHERE id::text = $1 AND is_active = true
      LIMIT 1
      `,
      [String(planId)]
    );

    if (planRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "Plan not found" };
    }

    const plan = planRes.rows[0];
    const baseCredits = Number(plan.credit_amount ?? 0);
    const bonusPct = Number(plan.bonus_percentage ?? 0);
    const bonusCredits = Math.floor((baseCredits * bonusPct) / 100);
    const totalCredits = baseCredits + bonusCredits;

    const { balance } = await addCredits({
      partnerId,
      credits: totalCredits,
      referenceType: "plan_purchase",
      referenceId: String(plan.id),
      message: `Purchased plan ${plan.plan_name}`,
      metadata: { plan_id: plan.id, plan_name: plan.plan_name, baseCredits, bonusPct, bonusCredits },
      client,
    });

    await client.query(
      `
      INSERT INTO plan_purchases (partner_id, plan_id, credits_granted, price, payment_reference)
      VALUES ($1,$2,$3,$4,$5)
      `,
      [String(partnerId), Number(plan.id), Number(totalCredits), Number(plan.price ?? 0), paymentReference ?? null]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      plan: {
        id: plan.id,
        plan_name: plan.plan_name,
        credit_amount: baseCredits,
        bonus_percentage: bonusPct,
        credits_granted: totalCredits,
        price: Number(plan.price ?? 0),
      },
      balance,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function listTransactions({ partnerId, limit = 200, offset = 0 }) {
  await ensureCreditSchema();

  const params = [];
  const where = [];

  if (partnerId) {
    params.push(String(partnerId));
    where.push(`partner_id = $${params.length}`);
  }

  params.push(Number(limit));
  params.push(Number(offset));

  const r = await pool.query(
    `
    SELECT id, partner_id, txn_type, delta_credits, balance_after, reference_type, reference_id, message, metadata, created_at
    FROM credit_transactions
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return r.rows;
}

async function upsertProductCost({ productKey, creditsPerOrder, isActive = true }) {
  await ensureCreditSchema();

  const r = await pool.query(
    `
    INSERT INTO product_credit_costs (product_key, credits_per_order, is_active, updated_at)
    VALUES ($1,$2,$3, now())
    ON CONFLICT (product_key)
    DO UPDATE SET credits_per_order = EXCLUDED.credits_per_order,
                  is_active = EXCLUDED.is_active,
                  updated_at = now()
    RETURNING product_key, credits_per_order, is_active, updated_at
    `,
    [String(productKey), Number(creditsPerOrder), Boolean(isActive)]
  );

  return r.rows[0];
}

async function listProductCosts() {
  await ensureCreditSchema();
  const r = await pool.query(
    `
    SELECT product_key, credits_per_order, is_active, updated_at
    FROM product_credit_costs
    ORDER BY product_key ASC
    `
  );
  return r.rows;
}

module.exports = {
  ensureCreditSchema,
  getCreditCostForOrder,
  getPartnerBalance,
  addCredits,
  deductCredits,
  purchasePlan,
  listTransactions,
  upsertProductCost,
  listProductCosts,
};
