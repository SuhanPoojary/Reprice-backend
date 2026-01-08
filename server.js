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
const allowedOrigins = [
  "http://localhost:5173",
  "https://reprice-ai-omega.vercel.app"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Postman / server calls

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  credentials: true,
}));

// 👇 REQUIRED FOR PREFLIGHT (THIS FIXES YOUR ERROR)
app.options("*", cors());

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
