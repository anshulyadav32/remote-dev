require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./auth/auth.routes");
const deviceRoutes = require("./routes/devices");
const { setupWebSocket } = require("./ws/wsHandler");
const { getDb, closeDb } = require("./db/database");

const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: "Too many requests, try again later" },
});

// --- Routes ---
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    name: "pc-remote backend",
    version: "1.0.0",
    uptime: process.uptime(),
  });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/devices", deviceRoutes);

// --- WebSocket ---
setupWebSocket(server);

// --- Initialize DB ---
getDb();

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     pc-remote backend server         ║
  ║                                      ║
  ║  REST API : http://localhost:${PORT}    ║
  ║  WebSocket: ws://localhost:${PORT}/ws   ║
  ╚══════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  closeDb();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDb();
  server.close();
  process.exit(0);
});
