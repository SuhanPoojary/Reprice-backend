const nodemailer = require("nodemailer");

function _env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function _isEmailLike(s) {
  return typeof s === "string" && s.includes("@");
}

function _getFrom() {
  const from = _env("SMTP_FROM", _env("SMTP_USER", "no-reply@reprice.local"));
  return from;
}

function _smtpConfigured() {
  const host = _env("SMTP_HOST");
  const user = _env("SMTP_USER");
  const pass = _env("SMTP_PASS");
  return Boolean(host && user && pass);
}

function _getTransport() {
  if (!_smtpConfigured()) return null;

  const host = _env("SMTP_HOST");
  const port = Number(_env("SMTP_PORT", "587"));
  const secure = String(_env("SMTP_SECURE", "")).toLowerCase() === "true" || port === 465;

  // Prevent long hangs when SMTP is slow/unreachable.
  const connectionTimeout = Number(_env("SMTP_CONNECTION_TIMEOUT_MS", "7000"));
  const greetingTimeout = Number(_env("SMTP_GREETING_TIMEOUT_MS", "7000"));
  const socketTimeout = Number(_env("SMTP_SOCKET_TIMEOUT_MS", "10000"));

  return nodemailer.createTransport({
    host,
    port,
    secure,
    connectionTimeout: Number.isFinite(connectionTimeout) ? connectionTimeout : 7000,
    greetingTimeout: Number.isFinite(greetingTimeout) ? greetingTimeout : 7000,
    socketTimeout: Number.isFinite(socketTimeout) ? socketTimeout : 10000,
    auth: {
      user: _env("SMTP_USER"),
      pass: _env("SMTP_PASS"),
    },
  });
}

async function sendEmail({ to, subject, text, html }) {
  if (!_isEmailLike(to)) {
    return { ok: false, skipped: true, reason: "invalid_to" };
  }

  const from = _getFrom();
  const transporter = _getTransport();

  if (!transporter) {
    // Dev fallback: don't fail the flow if SMTP isn't configured.
    console.log("\n--- EMAIL (SMTP not configured) ---");
    console.log("To:", to);
    console.log("Subject:", subject);
    console.log(text || "(no text)");
    console.log("--- END EMAIL ---\n");
    return { ok: true, skipped: true, reason: "smtp_not_configured" };
  }

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });

  return { ok: true };
}

function appBaseUrl() {
  // Where the partner will enter the code. Can be the Vercel partner portal.
  return _env("PARTNER_PORTAL_URL", _env("FRONTEND_URL", "https://reprice-agent-partner.vercel.app"));
}

function partnerVerificationEmail({ to, name, code }) {
  const subject = "Verify your email for Partner Application";
  const text = `Hi ${name || ""},\n\nYour MobileTrade partner email verification code is: ${code}\n\nEnter this code in the partner portal to submit your application for admin review.\n\nPartner portal: ${appBaseUrl()}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Verify your email</h2>
      <p>Hi ${name || ""},</p>
      <p>Your MobileTrade partner email verification code is:</p>
      <div style="font-size:28px;font-weight:700;letter-spacing:2px;padding:12px 16px;border:1px solid #ddd;display:inline-block">${code}</div>
      <p style="margin-top:16px">Enter this code in the partner portal to submit your application for admin review.</p>
      <p><a href="${appBaseUrl()}" target="_blank" rel="noreferrer">Open partner portal</a></p>
      <p style="color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  return { subject, text, html };
}

function partnerDecisionEmail({ to, name, approved, reason }) {
  const subject = approved ? "Your Partner Application was Approved" : "Your Partner Application was Rejected";
  const base = approved
    ? `Hi ${name || ""},\n\nGood news! Your partner application has been approved. You can now login to the partner portal using your phone + password.\n\nPartner portal: ${appBaseUrl()}\n`
    : `Hi ${name || ""},\n\nYour partner application has been rejected.\nReason: ${reason || "Not specified"}\n\nIf you believe this is a mistake, please contact support.`;

  const html = approved
    ? `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Application approved</h2>
        <p>Hi ${name || ""},</p>
        <p>Good news! Your partner application has been approved.</p>
        <p>You can now login to the partner portal using your phone + password.</p>
        <p><a href="${appBaseUrl()}" target="_blank" rel="noreferrer">Open partner portal</a></p>
      </div>
    `
    : `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Application rejected</h2>
        <p>Hi ${name || ""},</p>
        <p>Your partner application has been rejected.</p>
        <p><b>Reason:</b> ${reason || "Not specified"}</p>
      </div>
    `;

  return { subject, text: base, html };
}

module.exports = {
  sendEmail,
  partnerVerificationEmail,
  partnerDecisionEmail,
};
