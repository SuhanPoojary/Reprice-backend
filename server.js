const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const routes = require("./routes");
const { testConnection } = require("./db");

const app = express();

/* =========================
   ✅ FIX 1: PORT
========================= */
const PORT = process.env.PORT || 3001;

/* =========================
   ✅ FIX 2: CORS (PROPER)
========================= */
// Allow local dev + Vercel production + Vercel preview deployments
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "https://reprice-ai-omega.vercel.app",
  "https://reprice-admin-1.vercel.app",
  "https://reprice-agent-partner.vercel.app",
]);

// Also allow the env-provided frontend URL (useful for Render/Vercel)
if (process.env.FRONTEND_URL) {
  allowedOrigins.add(String(process.env.FRONTEND_URL).trim());
}

// Matches: https://reprice-agent-partner-<anything>.vercel.app
const vercelPreviewOriginRegex =
  /^https:\/\/reprice-agent-partner-[a-z0-9-]+\.vercel\.app$/i;

// Matches: https://reprice-admin-<anything>.vercel.app
const vercelAdminPreviewOriginRegex =
  /^https:\/\/reprice-admin-[a-z0-9-]+\.vercel\.app$/i;

// In dev, Vite may shift ports (5173, 5174, ...)
const localhostOriginRegex = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const corsOptions = {
  origin: function (origin, callback) {
    // Requests from tools like Postman or server-to-server may not send Origin
    if (!origin) return callback(null, true);

    const isDev = String(process.env.NODE_ENV || "").toLowerCase() !== "production";

    if (
      allowedOrigins.has(origin) ||
      vercelPreviewOriginRegex.test(origin) ||
      vercelAdminPreviewOriginRegex.test(origin) ||
      (isDev && localhostOriginRegex.test(origin))
    ) {
      return callback(null, true);
    }

    // Do not throw an error here; returning false prevents CORS headers cleanly.
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// 👇 REQUIRED FOR PREFLIGHT (must use SAME options)
app.options("*", cors(corsOptions));

app.use(express.json());

app.use("/api", routes);

// =========================
// ✅ Serve Frontends (Production)
// =========================
// Admin portal is mounted on a secret path (security via auth; path is just obscurity)
const ADMIN_PORTAL_PATH = String(process.env.ADMIN_PORTAL_PATH || "/__admin_portal_93c2f7");

if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
  const adminDistPath = path.join(__dirname, "..", "admin", "dist");
  const mainDistPath = path.join(__dirname, "..", "Agent-Partner-Dashboard", "dist");

  const hasAdminDist = fs.existsSync(path.join(adminDistPath, "index.html"));
  const hasMainDist = fs.existsSync(path.join(mainDistPath, "index.html"));

  if (hasAdminDist) {
    app.use(ADMIN_PORTAL_PATH, express.static(adminDistPath));
    app.get(`${ADMIN_PORTAL_PATH}/*`, (req, res) => {
      res.sendFile(path.join(adminDistPath, "index.html"));
    });
  }

  if (hasMainDist) {
    app.use(express.static(mainDistPath));
    // SPA fallback (avoid stealing /api or the admin portal)
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      if (hasAdminDist && req.path.startsWith(ADMIN_PORTAL_PATH)) return next();
      return res.sendFile(path.join(mainDistPath, "index.html"));
    });
  }
}

const startServer = async () => {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

startServer();
