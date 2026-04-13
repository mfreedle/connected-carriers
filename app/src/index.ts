import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pool, { migrate, migrateIntake, migrateDispatch, migrateInterest, migrateSetupPackets, migrateTwilio, migrateTeam, migrateCarrierProfiles } from "./db";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import carrierRoutes from "./routes/carriers";
import settingsRoutes from "./routes/settings";
import intakeRoutes from "./routes/intake";
import dispatchRoutes from "./routes/dispatch";
import interestRoutes from "./routes/interest";
import leadsRoutes from "./routes/leads";
import setupRoutes from "./routes/setup";
import trackingRoutes from "./routes/tracking";
import teamRoutes from "./routes/team";
import profileRoutes from "./routes/profile";
import { verifyCsrf } from "./middleware/security";

const app = express();
app.set("trust proxy", 1);
const PORT = parseInt(process.env.PORT || "4000");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ── Session secret — fail fast in production if not set ───────────
const SESSION_SECRET = process.env.SESSION_SECRET;
if (IS_PRODUCTION && !SESSION_SECRET) {
  console.error("FATAL: SESSION_SECRET environment variable is required in production. Exiting.");
  process.exit(1);
}

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
  secret: SESSION_SECRET || "cc-dev-only-not-for-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: IS_PRODUCTION,
    httpOnly: true,
  },
}));

// Public routes — no CSRF
app.get("/", (req, res) => res.redirect("/dashboard"));
app.use("/", authRoutes);
app.use("/", intakeRoutes);

app.use("/", interestRoutes);
app.use("/", setupRoutes);  // public /setup/:token routes
app.use("/", trackingRoutes); // public /track/:token routes
app.use("/", teamRoutes);      // team management + public invite acceptance
app.use("/", profileRoutes);   // public /profile/carrier route

// Broker routes — CSRF verification on all POSTs
app.use(verifyCsrf);
app.use("/", dashboardRoutes);
app.use("/", carrierRoutes);
app.use("/", settingsRoutes);
app.use("/", dispatchRoutes);
app.use("/", leadsRoutes);
app.use("/", setupRoutes);  // broker /carriers/:id/setup/* routes

// /setup — non-production only
if (!IS_PRODUCTION) {
  app.get("/setup", async (req, res) => {
    try {
      const { query } = await import("./db");
      const check = await query("SELECT COUNT(*) as count FROM broker_accounts");
      const count = parseInt(check.rows[0].count);
      if (count > 0) {
        return res.send(`Setup already complete — ${count} broker account(s) exist. <a href="/dashboard">Go to dashboard</a>`);
      }
      const seedModule = await import("./seed");
      await seedModule.default();
      res.send(`Setup complete. <a href="/login">Log in</a>`);
    } catch (err) {
      console.error("Setup error:", err);
      res.status(500).send(`Setup failed: ${err}`);
    }
  });
}

// 404
app.use((req, res) => {
  res.status(404).send("Page not found");
});

// Auto-run migrations on startup
migrate().then(() => migrateIntake()).then(() => migrateDispatch()).then(() => migrateInterest()).then(() => migrateSetupPackets()).then(() => migrateTwilio()).then(() => migrateTeam()).then(() => migrateCarrierProfiles())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Connected Carriers broker app running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });

export default app;
