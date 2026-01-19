const express = require("express");
const cors = require("cors");
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
  "http://localhost:3000",
  "https://reprice-ai-omega.vercel.app",
  "https://reprice-agent-partner.vercel.app",
]);

// Matches: https://reprice-agent-partner-<anything>.vercel.app
const vercelPreviewOriginRegex =
  /^https:\/\/reprice-agent-partner-[a-z0-9-]+\.vercel\.app$/i;

const corsOptions = {
  origin: function (origin, callback) {
    // Requests from tools like Postman or server-to-server may not send Origin
    if (!origin) return callback(null, true);

    if (allowedOrigins.has(origin) || vercelPreviewOriginRegex.test(origin)) {
      return callback(null, true);
    }

    // Do not throw an error here; returning false prevents CORS headers cleanly.
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// 👇 REQUIRED FOR PREFLIGHT (must use SAME options)
app.options("*", cors(corsOptions));

app.use(express.json());

app.use("/api", routes);

const startServer = async () => {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

startServer();
