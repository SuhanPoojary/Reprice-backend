const crypto = require("crypto");

function _boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
}

function _numEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function _newRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function requestLogger(req, res, next) {
  const requestId = req.headers["x-request-id"] || _newRequestId();
  req.requestId = String(requestId);

  const startNs = process.hrtime.bigint();
  req._startNs = startNs;

  res.setHeader("X-Request-Id", req.requestId);

  const logAll = _boolEnv("LOG_HTTP_ALL", false);
  const logStart = _boolEnv("LOG_HTTP_START", false);
  const slowMs = _numEnv("SLOW_REQ_MS", 2000);

  const origin = req.headers.origin;
  const ua = req.headers["user-agent"];

  if (logStart) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "http_request_start",
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        origin,
        ua,
      })
    );
  }

  res.on("finish", () => {
    const endNs = process.hrtime.bigint();
    const durationMs = Number(endNs - startNs) / 1e6;

    if (!logAll && durationMs < slowMs) return;

    console.log(
      JSON.stringify({
        level: durationMs >= slowMs ? "warn" : "info",
        msg: "http_request_finish",
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        origin,
      })
    );
  });

  next();
}

module.exports = { requestLogger };
