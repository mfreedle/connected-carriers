/**
 * Canonical load routes — broker app owns the load lifecycle.
 *
 * SPINE-0001 (Broker Load), SPINE-0002 (Carrier Identity), SPINE-0004 (Assignment)
 *
 * Broker routes (authenticated):
 *   POST /api/v2/loads/create       — create a load
 *   GET  /api/v2/loads              — list broker's loads
 *   GET  /api/v2/loads/:slug/applicants — list applicants for a load
 *   POST /api/v2/loads/:slug/assign — assign a carrier
 *
 * Public routes (carrier-facing):
 *   GET  /l/:slug               — load apply page
 *   POST /l/:slug/check         — MC qualification check
 *   POST /l/:slug/interest      — submit carrier interest
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { verifyCsrf } from "../middleware/security";
import { findOrCreateCarrier, updateCarrierFMCSA, updateCarrierContact } from "../carrier-identity";

const router = Router();

// ══════════════════════════════════════════════════════════════════
// BROKER ROUTES (authenticated, CSRF-protected)
// ══════════════════════════════════════════════════════════════════

// ── Create load ──────────────────────────────────────────────────

router.post("/api/v2/loads/create", requireAuth, verifyCsrf, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { origin, destination, equipment, pickup_date, pickup_address,
            pickup_window_text, broker_ref, notes, rate_note } = req.body;

    if (!origin || !destination || !equipment) {
      return res.status(400).json({ error: "Origin, destination, and equipment are required." });
    }

    // Get broker context from session
    const brokerResult = await query(
      "SELECT id, company_name, contact_phone, contact_email FROM broker_accounts WHERE id = $1",
      [req.session.brokerAccountId]
    );
    if (!brokerResult.rows.length) {
      return res.status(403).json({ error: "Broker account not found." });
    }
    const broker = brokerResult.rows[0];

    const loadId = `HX-${new Date().toISOString().slice(0, 10).replace(/-/g, "").slice(4)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const slug = crypto.randomBytes(4).toString("hex").toUpperCase();

    await query(`
      INSERT INTO canonical_loads
        (load_id, slug, broker_account_id, broker_name, broker_ref, broker_phone, broker_email,
         origin, destination, equipment, pickup_date, pickup_address, pickup_window_text,
         rate_note, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      loadId, slug, broker.id, broker.company_name,
      broker_ref?.trim() || null, broker.contact_phone || null, broker.contact_email || null,
      origin, destination, equipment, pickup_date || null,
      pickup_address || null, pickup_window_text || null,
      rate_note || null, notes || null,
    ]);

    const applyUrl = `/l/${slug}`;

    res.json({
      success: true,
      load_id: loadId,
      slug,
      apply_url: applyUrl,
    });
  } catch (err) {
    console.error("[v2/loads/create]", err);
    res.status(500).json({ error: "Failed to create load." });
  }
});

// ── List broker's loads ──────────────────────────────────────────

router.get("/api/v2/loads", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loads = await query(`
      SELECT cl.id, cl.load_id, cl.slug, cl.broker_ref, cl.origin, cl.destination,
             cl.equipment, cl.pickup_date, cl.pickup_address, cl.status, cl.created_at,
             COUNT(cla.id) FILTER (WHERE cla.qualification_result IN ('qualified','review')) as applicant_count,
             COUNT(cla.id) FILTER (WHERE cla.qualification_result = 'qualified' AND cla.contact_phone IS NOT NULL) as interested_count
      FROM canonical_loads cl
      LEFT JOIN canonical_load_applications cla ON cla.load_id = cl.id
      WHERE cl.broker_account_id = $1
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
      LIMIT 50
    `, [req.session.brokerAccountId]);

    // Get assignment + verification state for each load
    const assignments = await query(`
      SELECT la.load_id, la.status as assignment_status, la.carrier_id,
             c.mc_number, c.fmcsa_legal_name, c.network_status
      FROM load_assignments la
      JOIN carriers c ON c.id = la.carrier_id
      WHERE la.broker_account_id = $1
        AND la.status NOT IN ('superseded', 'cancelled')
      ORDER BY la.assigned_at DESC
    `, [req.session.brokerAccountId]);

    const assignMap: Record<number, typeof assignments.rows[0]> = {};
    for (const a of assignments.rows) { assignMap[a.load_id] = a; }

    // Compute operational status per SPINE-0001
    const enriched = loads.rows.map((l: Record<string, unknown>) => {
      const apps = parseInt(l.applicant_count as string) || 0;
      const interested = parseInt(l.interested_count as string) || 0;
      const assignment = assignMap[l.id as number];

      let pipeline = l.status as string;
      let pipeline_detail = "";

      if (l.status === "posted") {
        if (interested > 0) {
          pipeline = "ready_to_call";
          pipeline_detail = `${interested} carrier${interested !== 1 ? "s" : ""} interested`;
        } else if (apps > 0) {
          pipeline = "carriers_qualified";
          pipeline_detail = `${apps} qualified`;
        } else {
          pipeline_detail = "No applicants yet";
        }
      } else if (assignment) {
        pipeline = assignment.assignment_status;
        pipeline_detail = `${assignment.fmcsa_legal_name || "MC" + assignment.mc_number}`;
      }

      return { ...l, pipeline, pipeline_detail };
    });

    res.json({ loads: enriched });
  } catch (err) {
    console.error("[v2/loads]", err);
    res.status(500).json({ error: "Failed to fetch loads." });
  }
});

// ── Attention items (what needs action) ──────────────────────────

router.get("/api/v2/loads/attention", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loads = await query(`
      SELECT cl.id, cl.load_id, cl.slug, cl.origin, cl.destination, cl.equipment,
             cl.pickup_date, cl.status, cl.created_at,
             COUNT(cla.id) FILTER (WHERE cla.qualification_result IN ('qualified','review')) as applicant_count,
             COUNT(cla.id) FILTER (WHERE cla.qualification_result = 'qualified' AND cla.contact_phone IS NOT NULL) as interested_count
      FROM canonical_loads cl
      LEFT JOIN canonical_load_applications cla ON cla.load_id = cl.id
      WHERE cl.broker_account_id = $1 AND cl.status != 'cancelled'
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
      LIMIT 30
    `, [req.session.brokerAccountId]);

    // Get assignment state
    const assignments = await query(`
      SELECT la.load_id, la.status as assignment_status
      FROM load_assignments la
      WHERE la.broker_account_id = $1 AND la.status NOT IN ('superseded', 'cancelled')
    `, [req.session.brokerAccountId]);
    const assignMap: Record<number, string> = {};
    for (const a of assignments.rows) { assignMap[a.load_id] = a.assignment_status; }

    const items: { priority: number; icon: string; load_id: string; route: string; message: string; action: string }[] = [];

    for (const load of loads.rows) {
      const route = `${load.origin} → ${load.destination}`;
      const apps = parseInt(load.applicant_count as string) || 0;
      const interested = parseInt(load.interested_count as string) || 0;
      const aStatus = assignMap[load.id as number];

      if (load.status === "posted" && apps === 0) {
        items.push({ priority: 3, icon: "📭", load_id: load.load_id, route, message: "No applicants yet", action: "Repost or share the load link" });
      } else if (interested > 0 && !aStatus) {
        items.push({ priority: 1, icon: "👤", load_id: load.load_id, route, message: `${interested} carrier${interested !== 1 ? "s" : ""} interested`, action: "Review and assign" });
      } else if (apps > 0 && !interested && !aStatus) {
        items.push({ priority: 4, icon: "🔍", load_id: load.load_id, route, message: `${apps} qualified — waiting for interest`, action: "Check back soon" });
      }

      // Assignment states
      if (aStatus === "clear") {
        items.push({ priority: 1, icon: "✅", load_id: load.load_id, route, message: "Carrier verified — clear to dispatch", action: "Dispatch in TMS" });
      } else if (aStatus === "caution") {
        items.push({ priority: 0, icon: "🟡", load_id: load.load_id, route, message: "Carrier verified with flags", action: "Review before dispatch" });
      } else if (aStatus === "do_not_use") {
        items.push({ priority: 0, icon: "🔴", load_id: load.load_id, route, message: "Carrier failed verification", action: "Reassign" });
      } else if (aStatus === "verification_requested" || aStatus === "documents_pending") {
        items.push({ priority: 2, icon: "⏳", load_id: load.load_id, route, message: "Waiting on carrier docs", action: "System will follow up" });
      } else if (aStatus === "arrival_pending") {
        items.push({ priority: 2, icon: "📤", load_id: load.load_id, route, message: "Arrival check sent", action: "Waiting for driver" });
      } else if (aStatus === "arrival_confirmed") {
        items.push({ priority: 5, icon: "✅", load_id: load.load_id, route, message: "Driver confirmed on site", action: "Clear to load" });
      } else if (aStatus === "arrival_alert") {
        items.push({ priority: 0, icon: "🔴", load_id: load.load_id, route, message: "Driver location alert", action: "Call before loading" });
      }
    }

    items.sort((a, b) => a.priority - b.priority);
    res.json({ items, total_loads: loads.rows.length });
  } catch (err) {
    console.error("[v2/loads/attention]", err);
    res.status(500).json({ error: "Failed to fetch attention items." });
  }
});

// ── List applicants for a load ───────────────────────────────────

router.get("/api/v2/loads/:slug/applicants", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify load belongs to this broker
    const loadResult = await query(
      "SELECT id, load_id FROM canonical_loads WHERE slug = $1 AND broker_account_id = $2",
      [req.params.slug, req.session.brokerAccountId]
    );
    if (!loadResult.rows.length) {
      return res.status(404).json({ error: "Load not found." });
    }
    const load = loadResult.rows[0];

    // Ranked applicants per SPINE-0001
    const apps = await query(`
      SELECT cla.id, cla.carrier_id, cla.mc_number, cla.company_name,
             cla.contact_name, cla.contact_phone, cla.contact_email,
             cla.fmcsa_authority, cla.fmcsa_safety, cla.qualification_result,
             cla.has_profile, cla.profile_completion_status, cla.created_at,
             c.network_status, c.latest_profile_id, c.fmcsa_legal_name,
             la.id as assignment_id, la.status as assignment_status
      FROM canonical_load_applications cla
      JOIN carriers c ON c.id = cla.carrier_id
      LEFT JOIN load_assignments la ON la.load_application_id = cla.id
        AND la.status NOT IN ('superseded', 'cancelled')
      WHERE cla.load_id = $1
        AND cla.qualification_result IN ('qualified', 'review')
      ORDER BY
        CASE
          WHEN la.status = 'clear' THEN 0
          WHEN c.network_status = 'verified' THEN 1
          WHEN cla.has_profile = true AND cla.qualification_result = 'qualified' THEN 2
          WHEN cla.qualification_result = 'qualified' AND cla.contact_phone IS NOT NULL THEN 3
          WHEN cla.qualification_result = 'qualified' THEN 4
          WHEN cla.qualification_result = 'review' AND cla.contact_phone IS NOT NULL THEN 5
          WHEN cla.qualification_result = 'review' THEN 6
          ELSE 7
        END,
        cla.created_at ASC
    `, [load.id]);

    res.json({ load_id: load.load_id, applicants: apps.rows });
  } catch (err) {
    console.error("[v2/loads/applicants]", err);
    res.status(500).json({ error: "Failed to fetch applicants." });
  }
});

// ── Assign carrier ───────────────────────────────────────────────

router.post("/api/v2/loads/:slug/assign", requireAuth, verifyCsrf, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { applicant_id, driver_phone } = req.body;

    // Verify load belongs to this broker — get full load for downstream use
    const loadResult = await query(
      "SELECT * FROM canonical_loads WHERE slug = $1 AND broker_account_id = $2",
      [req.params.slug, req.session.brokerAccountId]
    );
    if (!loadResult.rows.length) {
      return res.status(404).json({ error: "Load not found." });
    }
    const load = loadResult.rows[0];

    // Verify applicant belongs to this load
    const appResult = await query(
      "SELECT * FROM canonical_load_applications WHERE id = $1 AND load_id = $2",
      [applicant_id, load.id]
    );
    if (!appResult.rows.length) {
      return res.status(404).json({ error: "Applicant not found on this load." });
    }
    const applicant = appResult.rows[0];

    // Get carrier identity for phone/email
    const carrierResult = await query("SELECT * FROM carriers WHERE id = $1", [applicant.carrier_id]);
    const carrier = carrierResult.rows[0];

    // Resolve carrier phone: prefer driver_phone from request, then applicant contact, then carrier identity
    const carrierPhone = (driver_phone || "").trim() || applicant.contact_phone || carrier?.phone_contact || "";

    // Get broker account for notification info
    const brokerResult = await query(
      "SELECT company_name, contact_phone, contact_email FROM broker_accounts WHERE id = $1",
      [req.session.brokerAccountId]
    );
    const broker = brokerResult.rows[0];

    // Check for existing active assignment on this load
    const existingAssignment = await query(
      `SELECT id FROM load_assignments WHERE load_id = $1 AND status NOT IN ('superseded', 'cancelled')`,
      [load.id]
    );
    if (existingAssignment.rows.length) {
      await query(
        `UPDATE load_assignments SET status = 'superseded', updated_at = NOW()
         WHERE load_id = $1 AND status NOT IN ('superseded', 'cancelled')`,
        [load.id]
      );
    }

    // Create assignment
    const assignment = await query(`
      INSERT INTO load_assignments
        (load_id, broker_account_id, carrier_id, load_application_id, assigned_by_user_id, status)
      VALUES ($1, $2, $3, $4, $5, 'assigned')
      RETURNING id
    `, [load.id, req.session.brokerAccountId, applicant.carrier_id, applicant.id, req.session.userId]);

    const assignmentId = assignment.rows[0].id;

    // Check carrier profile state to decide next step
    const profileResult = await query(
      `SELECT id, completion_status FROM carrier_profiles
       WHERE carrier_id = $1 AND completion_status = 'dispatch_ready'
       ORDER BY updated_at DESC LIMIT 1`,
      [applicant.carrier_id]
    );
    const profileComplete = profileResult.rows.length > 0;

    let nextAction: string;
    let nextStatus: string;
    let verificationId: number | null = null;

    if (profileComplete) {
      // ── FAST PATH: Profile dispatch-ready → clear, skip doc chase
      nextAction = "clear";
      nextStatus = "clear";

      // Notify broker
      if (broker?.contact_phone) {
        try {
          const { sendSms } = await import("../lib/sms");
          await sendSms(broker.contact_phone,
            `✓ ${applicant.company_name || "MC" + applicant.mc_number} assigned to ${load.load_id}. Profile complete — clear to dispatch.`
          );
        } catch (e) { console.error("[assign] broker SMS failed:", e); }
      }

    } else {
      // ── STANDARD PATH: Profile incomplete → trigger verification chase
      nextAction = "verification_chase";
      nextStatus = "verification_requested";

      if (!carrierPhone && !applicant.contact_email && !carrier?.email_contact) {
        // No way to contact carrier — mark as documents_pending, broker must follow up manually
        nextStatus = "documents_pending";
        nextAction = "manual_followup";

        if (broker?.contact_phone) {
          try {
            const { sendSms } = await import("../lib/sms");
            await sendSms(broker.contact_phone,
              `${applicant.company_name || "MC" + applicant.mc_number} assigned to ${load.load_id}. No carrier phone/email on file — follow up manually to get docs.`
            );
          } catch (e) { console.error("[assign] broker SMS failed:", e); }
        }
      } else {
        // Call the verify trigger
        const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";
        let triggerSucceeded = false;

        try {
          const triggerResp = await fetch(`${BASE_URL}/api/verify/trigger`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mc_number: applicant.mc_number,
              carrier_phone: carrierPhone || undefined,
              carrier_email: applicant.contact_email || carrier?.email_contact || undefined,
              carrier_name: applicant.company_name || carrier?.fmcsa_legal_name || undefined,
              broker_name: broker?.company_name || undefined,
              broker_phone: broker?.contact_phone || undefined,
              broker_email: broker?.contact_email || undefined,
              broker_account_id: req.session.brokerAccountId,
            }),
          });

          if (triggerResp.ok) {
            const triggerData = await triggerResp.json() as Record<string, unknown>;
            triggerSucceeded = true;
            verificationId = (triggerData.id as number) || null;

            if (triggerData.result === "DO_NOT_USE") {
              nextStatus = "do_not_use";
              nextAction = "fmcsa_rejected";

              if (broker?.contact_phone) {
                try {
                  const { sendSms } = await import("../lib/sms");
                  await sendSms(broker.contact_phone,
                    `⚠ ${applicant.company_name || "MC" + applicant.mc_number} — DO NOT USE on ${load.load_id}. FMCSA check failed.`
                  );
                } catch (e) { console.error("[assign] broker DNU SMS failed:", e); }
              }
            } else {
              // Verification request sent successfully
              if (broker?.contact_phone) {
                try {
                  const { sendSms } = await import("../lib/sms");
                  await sendSms(broker.contact_phone,
                    `${applicant.company_name || "MC" + applicant.mc_number} assigned to ${load.load_id}. Verification request sent — you'll get CLEAR, CAUTION, or DO NOT USE when they respond.`
                  );
                } catch (e) { console.error("[assign] broker SMS failed:", e); }
              }
            }
          } else {
            console.error("[assign] Verify trigger returned", triggerResp.status);
          }
        } catch (err) {
          console.error("[assign] Verify trigger call failed:", err);
        }

        if (!triggerSucceeded) {
          // Fallback: send carrier to profile form
          nextStatus = "documents_pending";
          nextAction = "verification_fallback";

          if (carrierPhone) {
            try {
              const BASE = process.env.BASE_URL || "https://app.connectedcarriers.org";
              const { sendSms } = await import("../lib/sms");
              await sendSms(carrierPhone,
                `${broker?.company_name || "A broker"} needs your docs for ${load.load_id} (${load.origin} → ${load.destination}). Submit here: ${BASE}/profile/carrier?source=load_assign&mc=${applicant.mc_number}`
              );
            } catch (e) { console.error("[assign] carrier fallback SMS failed:", e); }
          }

          if (broker?.contact_phone) {
            try {
              const { sendSms } = await import("../lib/sms");
              await sendSms(broker.contact_phone,
                `${applicant.company_name || "MC" + applicant.mc_number} assigned to ${load.load_id}. Auto-verify unavailable — sent carrier to profile form.`
              );
            } catch (e) { console.error("[assign] broker fallback SMS failed:", e); }
          }
        }
      }
    }

    // Update assignment with status and verification reference
    await query(
      `UPDATE load_assignments SET status = $1, carrier_verification_id = $2, updated_at = NOW() WHERE id = $3`,
      [nextStatus, verificationId, assignmentId]
    );

    // Update load status
    const loadStatus = nextStatus === "clear" ? "clear_to_dispatch"
      : nextStatus === "do_not_use" ? "do_not_use"
      : "waiting_on_docs";
    await query(
      "UPDATE canonical_loads SET status = $1, updated_at = NOW() WHERE id = $2",
      [loadStatus, load.id]
    );

    res.json({
      assigned: true,
      assignment_id: assignmentId,
      carrier: applicant.company_name || applicant.mc_number,
      mc: applicant.mc_number,
      next_action: nextAction,
      profile_complete: profileComplete,
    });
  } catch (err) {
    console.error("[v2/loads/assign]", err);
    res.status(500).json({ error: "Failed to assign carrier." });
  }
});

// ══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (carrier-facing, no auth)
// ══════════════════════════════════════════════════════════════════

// ── Load apply page ──────────────────────────────────────────────

router.get("/l/:slug", async (req: Request, res: Response) => {
  try {
    const load = await query(
      "SELECT * FROM canonical_loads WHERE slug = $1 AND status != 'cancelled'",
      [req.params.slug]
    );
    if (!load.rows.length) {
      return res.status(404).send(errorPage("This load is no longer available."));
    }
    res.send(loadApplyPage(load.rows[0]));
  } catch (err) {
    console.error("[apply/:slug]", err);
    res.status(500).send(errorPage("Something went wrong."));
  }
});

// ── MC qualification check ───────────────────────────────────────

router.post("/l/:slug/check", async (req: Request, res: Response) => {
  try {
    const load = await query(
      "SELECT * FROM canonical_loads WHERE slug = $1 AND status != 'cancelled'",
      [req.params.slug]
    );
    if (!load.rows.length) {
      return res.status(404).json({ error: "Load not found." });
    }
    const loadRow = load.rows[0];

    const mcRaw = (req.body.mc_number || "").replace(/\D/g, "");
    if (!mcRaw) {
      return res.status(400).json({ error: "MC number required." });
    }

    // Rate limit: 5 checks per MC per hour
    const recentChecks = await query(
      `SELECT COUNT(*) as count FROM canonical_load_applications
       WHERE mc_number = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [mcRaw]
    );
    if (parseInt(recentChecks.rows[0].count) >= 5) {
      return res.json({ qualification: "rate_limited", message: "Too many checks. Please try again later." });
    }

    // Resolve carrier identity
    const carrier = await findOrCreateCarrier(mcRaw);

    // Run FMCSA check
    let fmcsaResult: Record<string, unknown> = {};
    try {
      const saferUrl = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${mcRaw}&action=get_data`;
      const fmcsaResp = await fetch(saferUrl, { signal: AbortSignal.timeout(10000) });
      if (fmcsaResp.ok) {
        const html = await fmcsaResp.text();
        fmcsaResult = parseFMCSAHtml(html, mcRaw);
      }
    } catch (err) {
      console.error("[FMCSA lookup error]", err);
    }

    // Update carrier identity with FMCSA data
    if (fmcsaResult.found) {
      await updateCarrierFMCSA(carrier.id, {
        fmcsa_legal_name: fmcsaResult.entity_name as string,
        dot_number: fmcsaResult.usdot_number as string,
        fmcsa_status: fmcsaResult.usdot_status as string,
        authority_status: fmcsaResult.operating_status as string,
        safety_rating: fmcsaResult.safety_rating as string,
        phone: fmcsaResult.phone as string,
      });
    }

    // Qualification decision
    let qualification = "not_qualified";
    let authority = "Unknown";
    let safety = "Not Rated";

    if (!fmcsaResult.found) {
      qualification = "not_qualified";
    } else {
      authority = (fmcsaResult.operating_status as string) || "Unknown";
      safety = (fmcsaResult.safety_rating as string) || "Not Rated";

      const isActive = String(fmcsaResult.usdot_status || "").toUpperCase() === "ACTIVE";
      const isAuthorized = String(authority).toUpperCase().includes("AUTHORIZED");
      const isSafe = safety !== "Unsatisfactory";

      if (isActive && isAuthorized && isSafe) {
        qualification = safety === "Conditional" ? "review" : "qualified";
      }
    }

    // Check if already applied
    const existing = await query(
      "SELECT id FROM canonical_load_applications WHERE load_id = $1 AND carrier_id = $2",
      [loadRow.id, carrier.id]
    );

    if (existing.rows.length) {
      return res.json({
        qualification: existing.rows[0].qualification_result || qualification,
        already_applied: true,
        company_name: fmcsaResult.entity_name || carrier.fmcsa_legal_name,
        authority,
        safety,
        carrier_known: !carrier.isNew,
        carrier_phone: carrier.phone,
        carrier_email: carrier.email,
      });
    }

    // Create application stub (contact info added on interest submission)
    if (qualification !== "not_qualified") {
      await query(`
        INSERT INTO canonical_load_applications
          (load_id, carrier_id, mc_number, company_name, fmcsa_authority, fmcsa_safety, fmcsa_company, qualification_result)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (load_id, carrier_id) DO UPDATE SET
          fmcsa_authority = EXCLUDED.fmcsa_authority,
          fmcsa_safety = EXCLUDED.fmcsa_safety,
          qualification_result = EXCLUDED.qualification_result
      `, [
        loadRow.id, carrier.id, mcRaw,
        fmcsaResult.entity_name || null, authority, safety,
        fmcsaResult.entity_name || null, qualification,
      ]);

      // Update load status if first qualified applicant
      if (loadRow.status === "posted") {
        await query(
          "UPDATE canonical_loads SET status = 'carriers_qualified', updated_at = NOW() WHERE id = $1 AND status = 'posted'",
          [loadRow.id]
        );
      }
    }

    res.json({
      qualification,
      company_name: fmcsaResult.entity_name || carrier.fmcsa_legal_name,
      authority,
      safety,
      carrier_known: !carrier.isNew,
      carrier_phone: carrier.phone,
      carrier_email: carrier.email,
    });
  } catch (err) {
    console.error("[apply/check]", err);
    res.status(500).json({ error: "Qualification check failed." });
  }
});

// ── Submit carrier interest ──────────────────────────────────────

router.post("/l/:slug/interest", async (req: Request, res: Response) => {
  try {
    const load = await query(
      "SELECT * FROM canonical_loads WHERE slug = $1 AND status != 'cancelled'",
      [req.params.slug]
    );
    if (!load.rows.length) {
      return res.status(404).json({ error: "Load not found." });
    }
    const loadRow = load.rows[0];

    const mcRaw = (req.body.mc_number || "").replace(/\D/g, "");
    const name = (req.body.name || "").trim();
    const phone = (req.body.phone || "").trim();
    const email = (req.body.email || "").trim();

    if (!mcRaw) return res.status(400).json({ error: "MC number required." });

    // Resolve carrier
    const carrier = await findOrCreateCarrier(mcRaw);

    // Verify carrier has a qualified application on this load
    const appCheck = await query(
      `SELECT id, qualification_result FROM canonical_load_applications
       WHERE load_id = $1 AND carrier_id = $2 AND qualification_result IN ('qualified', 'review')`,
      [loadRow.id, carrier.id]
    );
    if (!appCheck.rows.length) {
      return res.status(400).json({ error: "No qualified application found. Please check your MC first." });
    }

    // Update carrier contact info
    await updateCarrierContact(carrier.id, phone || undefined, email || undefined);

    // Update application with contact info
    const updateResult = await query(`
      UPDATE canonical_load_applications
      SET contact_name = $1, contact_phone = $2, contact_email = $3
      WHERE load_id = $4 AND carrier_id = $5 AND qualification_result IN ('qualified', 'review')
    `, [name || null, phone || null, email || null, loadRow.id, carrier.id]);

    // Update load status to ready_to_call if this is first interested carrier
    await query(
      `UPDATE canonical_loads SET status = 'ready_to_call', updated_at = NOW()
       WHERE id = $1 AND status IN ('posted', 'carriers_qualified')`,
      [loadRow.id]
    );

    // Notify broker via SMS if phone is on file
    if (loadRow.broker_phone) {
      try {
        const { sendSms } = await import("../lib/sms");
        await sendSms(loadRow.broker_phone,
          `New carrier interest: ${carrier.fmcsa_legal_name || "MC" + mcRaw} on ${loadRow.load_id} (${loadRow.origin} → ${loadRow.destination}).${phone ? " Phone: " + phone : ""}`
        );
      } catch (smsErr) {
        console.error("[apply/interest] SMS failed:", smsErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[apply/interest]", err);
    res.status(500).json({ error: "Failed to submit interest." });
  }
});

export default router;


// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function parseFMCSAHtml(html: string, mc: string): Record<string, unknown> {
  if (html.includes("No records found") || html.includes("no records found")) {
    return { found: false, mc_number: mc };
  }

  const rowData: Record<string, string> = {};
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const tdPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(trMatch[1])) !== null) {
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (text) cells.push(text);
    }
    for (let i = 0; i < cells.length - 1; i += 2) {
      rowData[cells[i].replace(/:?\s*$/, "").trim()] = cells[i + 1].trim();
    }
  }

  const usdotStatus = rowData["USDOT Status"] || "";
  const operatingStatus = rowData["Operating Authority Status"] || "";

  return {
    found: true,
    mc_number: mc,
    entity_name: rowData["Legal Name"] || null,
    usdot_number: rowData["USDOT Number"] || null,
    usdot_status: usdotStatus,
    operating_status: operatingStatus,
    safety_rating: rowData["Rating"] || rowData["Safety Rating"] || "Not Rated",
    phone: rowData["Phone"] || null,
    power_units: rowData["Power Units"] || null,
    active: usdotStatus.toUpperCase() === "ACTIVE",
    authorized: operatingStatus.toUpperCase().includes("AUTHORIZED"),
  };
}


function errorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unavailable — Connected Carriers</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#F7F5F0;border-radius:4px;padding:36px 32px;max-width:400px;width:100%;text-align:center}
h2{font-size:18px;color:#1C2B3A;margin-bottom:10px}p{font-size:14px;color:#6B7A8A;line-height:1.6}</style>
</head><body><div class="card"><h2>Unavailable</h2><p>${message}</p></div></body></html>`;
}


function loadApplyPage(load: Record<string, unknown>): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${load.origin} → ${load.destination} — Connected Carriers</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#1C2B3A;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#F7F5F0;border-radius:8px;padding:24px;max-width:420px;width:100%}
  .tag{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#C8892A;font-weight:600;margin-bottom:6px}
  .route{font-size:22px;font-weight:600;color:#1C2B3A;margin-bottom:4px}
  .detail{font-size:13px;color:#6B7A8A;margin-bottom:2px}
  .divider{height:1px;background:#E0DAD0;margin:16px 0}
  .label{font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#6B7A8A;font-weight:600;margin-bottom:6px}
  .mc-input{width:100%;padding:12px 14px;border:1px solid #e8e4de;border-radius:6px;font-size:18px;text-align:center;font-weight:600;outline:none}
  .mc-input:focus{border-color:#C8892A}
  .btn{width:100%;padding:12px;background:#C8892A;border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
  .btn:disabled{opacity:0.5}
  .result{display:none;padding:12px;border-radius:6px;margin-top:12px}
  .result.qualified{background:#EAF3DE;border:1px solid #C5E0A0}
  .result.review{background:#FFF8E1;border:1px solid #FFE082}
  .result.not_qualified{background:#FFEBEE;border:1px solid #FFCDD2}
  .result h3{font-size:15px;margin-bottom:4px}
  .result p{font-size:12px;color:#6B7A8A}
  .interest-form{display:none;margin-top:16px}
  .interest-form input{width:100%;padding:10px 12px;border:1px solid #e8e4de;border-radius:6px;font-size:14px;margin-bottom:8px;outline:none}
  .interest-form input:focus{border-color:#C8892A}
  .interest-btn{width:100%;padding:12px;background:#1C2B3A;border:none;border-radius:6px;color:#F7F5F0;font-size:14px;font-weight:600;cursor:pointer}
  .submitted-msg{display:none;text-align:center;margin-top:16px}
  .submitted-msg .check{font-size:36px;margin-bottom:8px}
  .submitted-msg p{font-size:14px;color:#6B7A8A}
  .docs-cta{display:block;width:100%;padding:14px;background:#C8892A;border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;margin-top:16px}
  .docs-cta:hover{background:#E09B35}
  .docs-hint{font-size:12px;color:#6B7A8A;margin-top:8px;text-align:center}
  .profile-link{display:block;margin-top:12px;text-align:center;font-size:12px;color:#C8892A;text-decoration:none}
  .powered{text-align:center;font-size:11px;color:#6B7A8A;margin-top:20px}
  .powered a{color:#C8892A;text-decoration:none}
  .welcome{background:#E8F5E9;border:1px solid #C8E6C9;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#2e7d32}
</style>
</head>
<body>
<div class="card">
  <div class="tag">Load Available</div>
  <div class="route">${load.origin} → ${load.destination}</div>
  <div class="detail">${load.equipment}${load.pickup_date ? ` · Pickup: ${load.pickup_date}` : ""}</div>
  ${load.rate_note ? `<div class="detail">${load.rate_note}</div>` : ""}

  <div class="divider"></div>

  <div id="welcome-back" class="welcome" style="display:none"></div>

  <div id="check-view">
    <div class="label">Enter your MC number</div>
    <input type="text" class="mc-input" id="mc-input" placeholder="1234567" inputmode="numeric" maxlength="10" autocomplete="off">
    <button class="btn" id="check-btn" onclick="checkMC()">Check Qualification</button>
  </div>

  <div class="result" id="result-box">
    <h3 id="result-title"></h3>
    <p id="result-detail"></p>
  </div>

  <div class="interest-form" id="interest-form">
    <div class="label" style="margin-bottom:8px">Submit your interest</div>
    <input type="text" id="int-name" placeholder="Your name">
    <input type="tel" id="int-phone" placeholder="Phone number" inputmode="tel">
    <input type="email" id="int-email" placeholder="Email (optional)">
    <button class="interest-btn" id="interest-btn" onclick="submitInterest()">I'm Interested in This Load</button>
    <a href="/profile/carrier" class="profile-link" id="profile-link-interest">Complete your carrier profile for faster qualification →</a>
  </div>

  <div class="submitted-msg" id="submitted-msg">
    <div class="check">✓</div>
    <p>You're qualified. The broker has your info.</p>
    <p style="margin-top:8px;color:#1C2B3A;font-weight:500;font-size:15px">Submit your docs now to get dispatched first.</p>
    <a href="/profile/carrier" class="docs-cta" id="profile-link-submitted">Upload CDL, Insurance & Cab Card →</a>
    <div class="docs-hint">Carriers with docs on file get assigned before those without. Takes 2 minutes.</div>
  </div>

  <div class="powered">Powered by <a href="https://connectedcarriers.org">Connected Carriers</a></div>
</div>

<script>
let mcChecked = '';
const slug = '${load.slug}';

function profileUrl(mc, name, phone, email) {
  const base = '/profile/carrier';
  const params = new URLSearchParams();
  if (mc) params.set('mc', mc);
  if (name) params.set('name', name);
  if (phone) params.set('phone', phone);
  if (email) params.set('email', email);
  params.set('source', 'load_apply');
  const qs = params.toString();
  return qs ? base + '?' + qs : base;
}

function updateProfileLinks(mc, name, phone, email) {
  const url = profileUrl(mc, name, phone, email);
  const link1 = document.getElementById('profile-link-interest');
  const link2 = document.getElementById('profile-link-submitted');
  if (link1) link1.href = url;
  if (link2) link2.href = url;
}

async function checkMC() {
  const mc = document.getElementById('mc-input').value.replace(/\\D/g, '');
  if (!mc) return;
  const btn = document.getElementById('check-btn');
  btn.disabled = true; btn.textContent = 'Checking...';

  try {
    const res = await fetch('/l/' + slug + '/check', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mc_number: mc})
    });
    const data = await res.json();
    mcChecked = mc;

    const box = document.getElementById('result-box');
    const title = document.getElementById('result-title');
    const detail = document.getElementById('result-detail');
    box.style.display = 'block';
    box.className = 'result ' + data.qualification;

    if (data.qualification === 'qualified') {
      title.textContent = '✓ Qualified — ' + (data.company_name || 'MC ' + mc);
      detail.textContent = 'Authority: ' + data.authority + ' · Safety: ' + data.safety;
      document.getElementById('interest-form').style.display = 'block';

      // Pre-fill if returning carrier
      if (data.carrier_known) {
        if (data.carrier_phone) document.getElementById('int-phone').value = data.carrier_phone;
        if (data.carrier_email) document.getElementById('int-email').value = data.carrier_email;
        document.getElementById('welcome-back').textContent = 'Welcome back, ' + (data.company_name || 'MC ' + mc) + '. Your info is on file.';
        document.getElementById('welcome-back').style.display = 'block';
      }

      updateProfileLinks(mc, '', '', '');
    } else if (data.qualification === 'review') {
      title.textContent = '⚠ Needs Review — ' + (data.company_name || 'MC ' + mc);
      detail.textContent = 'Authority: ' + data.authority + ' · Safety: ' + data.safety + '. The broker may follow up.';
      document.getElementById('interest-form').style.display = 'block';
      updateProfileLinks(mc, '', '', '');
    } else if (data.qualification === 'rate_limited') {
      title.textContent = '⏳ Please wait';
      detail.textContent = data.message;
    } else {
      title.textContent = '✗ Not Qualified';
      detail.textContent = data.company_name
        ? data.company_name + ' — authority or safety status does not meet requirements.'
        : 'MC number not found in FMCSA database.';
    }

    if (data.already_applied) {
      title.textContent = '✓ Qualified — Already checked';
      detail.textContent = 'Authority: ' + data.authority + ' · Safety: ' + data.safety;
    }
  } catch (e) {
    document.getElementById('result-box').style.display = 'block';
    document.getElementById('result-box').className = 'result not_qualified';
    document.getElementById('result-title').textContent = 'Error';
    document.getElementById('result-detail').textContent = 'Could not check qualification. Please try again.';
  }
  btn.disabled = false; btn.textContent = 'Check Another MC';
}

async function submitInterest() {
  const btn = document.getElementById('interest-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';

  try {
    await fetch('/l/' + slug + '/interest', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        mc_number: mcChecked,
        name: document.getElementById('int-name').value,
        phone: document.getElementById('int-phone').value,
        email: document.getElementById('int-email').value
      })
    });
    document.getElementById('interest-form').style.display = 'none';
    document.getElementById('submitted-msg').style.display = 'block';
    updateProfileLinks(
      mcChecked,
      document.getElementById('int-name').value,
      document.getElementById('int-phone').value,
      document.getElementById('int-email').value
    );
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "I'm Interested in This Load";
    alert('Error submitting interest. Please try again.');
  }
}
</script>
</body>
</html>`;
}
