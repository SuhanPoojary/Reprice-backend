const express = require("express");
const cors = require("cors");
require("dotenv").config();

const routes = require("./routes");
const { testConnection } = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

app.use("/api", routes);

const startServer = async () => {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
};

startServer();
