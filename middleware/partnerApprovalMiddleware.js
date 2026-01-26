const { pool } = require("../db");

function normalizePartnerId(req) {
  const raw = req?.user?.id;
  const partnerId = String(raw ?? "").trim();
  return partnerId.length > 0 ? partnerId : null;
}

async function ensurePartnerApproved(req, res, next) {
  try {
    // This middleware is intended to run after authenticateToken + isPartner.
    if (req?.user?.userType !== "partner") return next();

    const partnerId = normalizePartnerId(req);
    if (!partnerId) {
      return res.status(401).json({ success: false, message: "Invalid partner identity" });
    }

    const result = await pool.query(
      `
      SELECT
        COALESCE(verification_status, 'approved') AS verification_status,
        COALESCE(is_active, true) AS is_active,
        rejection_reason
      FROM partners
      WHERE id::text = $1
      LIMIT 1
      `,
      [partnerId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Partner not found" });
    }

    const status = result.rows[0];
    const verificationStatus = String(status.verification_status || "approved").toLowerCase();
    const isActive = Boolean(status.is_active);

    const isClarification =
      verificationStatus === "clarification" || verificationStatus === "clarification_needed";

    if (!isActive || verificationStatus !== "approved") {
      return res.status(403).json({
        success: false,
        code: "PARTNER_NOT_APPROVED",
        message:
          verificationStatus === "rejected"
            ? "Partner application was rejected"
            : isClarification
              ? "Partner application needs clarification"
              : "Partner application is pending approval",
        verification_status: verificationStatus,
        is_active: isActive,
        rejection_reason: status.rejection_reason ?? null,
      });
    }

    return next();
  } catch (err) {
    console.error("PARTNER APPROVAL CHECK ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to validate partner status" });
  }
}

module.exports = {
  ensurePartnerApproved,
};
