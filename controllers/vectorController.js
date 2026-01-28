const DEFAULT_VECTOR_BACKEND_URL = "https://reprice-ml-backend.onrender.com";
const crypto = require("crypto");
const csvParser = require("csv-parser");
const { Readable } = require("stream");

function getVectorBaseUrl() {
  const raw = String(process.env.VECTOR_BACKEND_URL || DEFAULT_VECTOR_BACKEND_URL).trim();
  return raw.replace(/\/$/, "");
}

async function forwardJson(req, res, targetUrl, init) {
  try {
    const upstream = await fetch(targetUrl, init);

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    res.status(upstream.status);
    if (contentType) res.setHeader("Content-Type", contentType);

    return res.send(text);
  } catch (err) {
    console.error("VECTOR PROXY ERROR:", err);
    return res.status(502).json({ success: false, message: "Vector backend unreachable" });
  }
}

function stableVectorIdFromMetadata(md) {
  const brand = String(md?.brand ?? "").trim();
  const model = String(md?.model ?? "").trim();
  const variant = String(md?.variant ?? "").trim();
  const base = `${brand}|${model}|${variant}`;
  const hash = crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
  return `phone_${hash}`;
}

exports.vectorHealth = async (req, res) => {
  const url = `${getVectorBaseUrl()}/health`;
  return forwardJson(req, res, url, { method: "GET" });
};

exports.vectorSearchPhones = async (req, res) => {
  const base = getVectorBaseUrl();
  const url = `${base}/admin/phones/search`;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req.body || {}),
    });

    // If the deployed vector backend doesn't have admin endpoints yet, fall back
    // to its public /search endpoint and adapt response for the admin UI.
    if (upstream.status === 404) {
      const q = String(req.body?.q ?? "").trim();
      const topK = Number(req.body?.top_k ?? req.body?.top_k ?? 10);
      const fallback = await fetch(`${base}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ q, top_k: Number.isFinite(topK) ? topK : 10 }),
      });

      const payload = await fallback.json().catch(() => null);
      const phones = Array.isArray(payload?.phones) ? payload.phones : Array.isArray(payload) ? payload : [];
      const matches = phones
        .filter((md) => md && typeof md === "object")
        .map((md) => ({ id: stableVectorIdFromMetadata(md), metadata: md }));

      return res.json({ query: q, count: matches.length, matches, mode: "fallback_search" });
    }

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();
    res.status(upstream.status);
    if (contentType) res.setHeader("Content-Type", contentType);
    return res.send(text);
  } catch (err) {
    console.error("VECTOR PROXY ERROR:", err);
    return res.status(502).json({ success: false, message: "Vector backend unreachable" });
  }
};

exports.vectorUpsertPhone = async (req, res) => {
  const url = `${getVectorBaseUrl()}/admin/phones/upsert`;
  return forwardJson(req, res, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(req.body || {}),
  });
};

exports.vectorDeletePhone = async (req, res) => {
  const id = encodeURIComponent(String(req.params.id));
  const url = `${getVectorBaseUrl()}/admin/phones/${id}`;
  return forwardJson(req, res, url, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
};

function parseCsvText(csvText) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const s = Readable.from([String(csvText || "")]);
    s.pipe(csvParser())
      .on("data", (data) => rows.push(data))
      .on("end", () => resolve(rows))
      .on("error", (err) => reject(err));
  });
}

function normalizeRow(row) {
  const r = row && typeof row === "object" ? row : {};
  const byLower = {};
  for (const [k, v] of Object.entries(r)) {
    byLower[String(k).toLowerCase()] = v;
  }

  const brand = String(byLower.brand ?? "").trim();
  const model = String(byLower.model ?? "").trim();
  const variant = String(byLower.variant ?? "").trim();
  const id = String(byLower.id ?? "").trim();
  const image = String(byLower.image ?? "").trim();
  const link = String(byLower.link ?? byLower.url ?? "").trim();

  const priceRaw = byLower.price;
  const priceNum = priceRaw === undefined || priceRaw === null || String(priceRaw).trim() === "" ? undefined : Number(priceRaw);
  const price = Number.isFinite(priceNum) ? priceNum : undefined;

  if (!brand || !model) {
    throw new Error("Missing required brand/model");
  }

  const known = new Set(["id", "brand", "model", "variant", "price", "image", "link", "url"]);
  const extras = {};
  for (const [k, v] of Object.entries(byLower)) {
    if (known.has(k)) continue;
    extras[k] = v;
  }

  return {
    id: id || undefined,
    brand,
    model,
    variant: variant || undefined,
    price,
    image: image || (link && link.startsWith("http") ? link : undefined),
    link: link || undefined,
    ...extras,
  };
}

exports.vectorUploadPhonesCsv = async (req, res) => {
  try {
    const csv = String(req.body?.csv || "");
    if (!csv.trim()) {
      return res.status(400).json({ ok: false, message: "Missing csv" });
    }

    const rows = await parseCsvText(csv);
    if (!rows.length) {
      return res.status(400).json({ ok: false, message: "No rows found in CSV" });
    }

    const items = [];
    const errors = [];

    rows.forEach((row, idx) => {
      try {
        items.push(normalizeRow(row));
      } catch (e) {
        errors.push({ row: idx + 1, error: e?.message || String(e) });
      }
    });

    if (!items.length) {
      return res.status(422).json({ ok: false, message: "No valid rows", errors });
    }

    const url = `${getVectorBaseUrl()}/admin/phones/upsert-batch`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items }),
    });

    const payload = await upstream.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return res
        .status(upstream.status)
        .json({ ok: false, message: "Invalid response from vector backend", errors });
    }

    const upstreamErrors = Array.isArray(payload.errors) ? payload.errors : [];
    const mergedErrors = [...errors, ...upstreamErrors];
    const upserted = Number(payload.upserted ?? 0);
    const upstreamFailed = Number(payload.failed ?? 0);
    const failed = upstreamFailed + errors.length;

    return res.status(upstream.status).json({
      ...payload,
      upserted,
      failed,
      errors: mergedErrors,
      parsed_rows: rows.length,
      valid_rows: items.length,
      invalid_rows: errors.length,
    });
  } catch (err) {
    console.error("CSV UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, message: err?.message || "CSV upload failed" });
  }
};
