import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pool, { migrate } from "./db";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import carrierRoutes from "./routes/carriers";
import settingsRoutes from "./routes/settings";

const app = express();
const PORT = parseInt(process.env.PORT || "4000");

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: false,
  }),
  secret: process.env.SESSION_SECRET || "cc-dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  },
}));

// Routes
app.get("/", (req, res) => res.redirect("/dashboard"));
app.use("/", authRoutes);
app.use("/", dashboardRoutes);
app.use("/", carrierRoutes);
app.use("/", settingsRoutes);

// One-time setup route — runs seed if no broker accounts exist yet
app.get("/setup", async (req, res) => {
  try {
    const { query } = await import("./db");
    const check = await query("SELECT COUNT(*) as count FROM broker_accounts");
    const count = parseInt(check.rows[0].count);
    if (count > 0) {
      return res.send(`Setup already complete — ${count} broker account(s) exist. <a href="/dashboard">Go to dashboard</a>`);
    }
    // Run seed
    const { default: runSeed } = await import("./seed");
    await runSeed();
    res.send(`Setup complete. <a href="/login">Log in as kateloads@logisticsxpress.com / password123</a>`);
  } catch (err) {
    console.error("Setup error:", err);
    res.status(500).send(`Setup failed: ${err}`);
  }
});

// 404
app.use((req, res) => {
  res.status(404).send("Page not found");
});

// Auto-run migrations on startup
migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Connected Carriers broker app running on port ${PORT}`);
      console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
    });
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });

export default app;
