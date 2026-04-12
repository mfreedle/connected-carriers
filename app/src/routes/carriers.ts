import { Router, Response, Request } from "express";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { h, csrfToken, csrfField } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

// Carrier detail — single screen review
router.get("/carriers/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const carrierId = parseInt(req.params.id);

  try {
    const carrierRes = await query(`
      SELECT c.*, ba.company_name as broker_company
      FROM carriers c
      JOIN broker_accounts ba ON ba.id = c.broker_account_id
      WHERE c.id = $1 AND c.broker_account_id = $2
    `, [carrierId, accountId]);

    if (!carrierRes.rows.length) {
      return res.status(404).send("Carrier not found");
    }

    const carrier = carrierRes.rows[0];

    const submissionsRes = await query(`
      SELECT cs.*, bu.name as reviewer_name
      FROM carrier_submissions cs
      LEFT JOIN broker_users bu ON bu.id = cs.reviewed_by
      WHERE cs.carrier_id = $1
      ORDER BY cs.submitted_at DESC
    `, [carrierId]);

    const docsRes = await query(`
      SELECT * FROM carrier_documents WHERE carrier_id = $1 ORDER BY created_at DESC
    `, [carrierId]);

    const notesRes = await query(`
      SELECT cn.*, bu.name as author_name
      FROM carrier_notes cn
      JOIN broker_users bu ON bu.id = cn.broker_user_id
      WHERE cn.carrier_id = $1
      ORDER BY cn.created_at DESC
    `, [carrierId]);

    const activityRes = await query(`
      SELECT * FROM activity_logs
      WHERE subject_type IN ('carrier', 'carrier_submission') AND subject_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [carrierId]);

    const csrf = csrfToken(req);
    const html = layout({
      title: String(carrier.legal_name || carrier.company_name || "Carrier Detail"),
      userName: req.session.userName || "",
      csrfToken: csrf,
      content: carrierDetailContent(
        carrier,
        submissionsRes.rows,
        docsRes.rows,
        notesRes.rows,
        activityRes.rows,
        req.query.success as string,
        csrf
      ),
    });

    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading carrier");
  }
});

// Decision action
router.post("/carriers/:id/decision", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const userId = req.session.userId;
  const carrierId = parseInt(req.params.id);
  const { action, decision_reason, submission_id } = req.body;

  if (!action || !decision_reason) {
    return res.redirect(`/carriers/${carrierId}?error=missing_fields`);
  }

  const actionMap: Record<string, { carrierStatus: string; submissionStatus: string; tier: string }> = {
    approve:          { carrierStatus: "approved",      submissionStatus: "approved",      tier: "approved" },
    conditional:      { carrierStatus: "conditional",   submissionStatus: "conditional",   tier: "conditional" },
    reject:           { carrierStatus: "rejected",      submissionStatus: "rejected",      tier: "rejected" },
    more_info:        { carrierStatus: "under_review",  submissionStatus: "more_info_requested", tier: "manual_review" },
  };

  const mapped = actionMap[action];
  if (!mapped) return res.redirect(`/carriers/${carrierId}?error=invalid_action`);

  try {
    await query(`
      UPDATE carriers SET
        onboarding_status = $1, approval_tier = $2, updated_at = NOW()
      WHERE id = $3 AND broker_account_id = $4
    `, [mapped.carrierStatus, mapped.tier, carrierId, accountId]);

    if (submission_id) {
      await query(`
        UPDATE carrier_submissions SET
          status = $1, reviewed_at = NOW(), reviewed_by = $2, decision_reason = $3
        WHERE id = $4 AND broker_account_id = $5
      `, [mapped.submissionStatus, userId, decision_reason, submission_id, accountId]);
    }

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('carrier', $1, 'broker_user', $2, $3, $4)
    `, [carrierId, userId, action, JSON.stringify({ reason: decision_reason, submission_id })]);

    res.redirect(`/carriers/${carrierId}?success=${action}`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}?error=server_error`);
  }
});

// Add note
router.post("/carriers/:id/notes", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const userId = req.session.userId;
  const carrierId = parseInt(req.params.id);
  const { body } = req.body;

  if (!body?.trim()) return res.redirect(`/carriers/${carrierId}`);

  try {
    await query(`
      INSERT INTO carrier_notes (carrier_id, broker_account_id, broker_user_id, body)
      VALUES ($1, $2, $3, $4)
    `, [carrierId, accountId, userId, body.trim()]);

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('carrier', $1, 'broker_user', $2, 'note_added', $3)
    `, [carrierId, userId, JSON.stringify({ note: body.trim().slice(0, 100) })]);

    res.redirect(`/carriers/${carrierId}#notes`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}`);
  }
});

export default router;

function statusBadge(status: string): string {
  const map: Record<string, { label: string; color: string }> = {
    submitted:           { label: "New",          color: "#3b82f6" },
    under_review:        { label: "Under Review", color: "#f59e0b" },
    approved:            { label: "Approved",     color: "#10b981" },
    conditional:         { label: "Conditional",  color: "#f97316" },
    rejected:            { label: "Rejected",     color: "#ef4444" },
    more_info_requested: { label: "More Info",    color: "#8b5cf6" },
    draft:               { label: "Draft",        color: "#6b7a8a" },
  };
  const s = map[status] || { label: status, color: "#6b7a8a" };
  return `<span class="badge" style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}40">${s.label}</span>`;
}

function docTypeLabel(type: string): string {
  const map: Record<string, string> = {
    coi: "Certificate of Insurance",
    w9: "W-9",
    signed_agreement: "Carrier Agreement",
    cdl: "CDL",
    truck_photo: "Truck Photo",
    vin_photo: "VIN Photo",
    cab_card: "Cab Card",
    rate_confirmation: "Rate Confirmation",
    other: "Other",
  };
  return map[type] || type;
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    approved: "✓ Approved carrier",
    conditional_approved: "⚠ Conditionally approved",
    rejected: "✗ Rejected carrier",
    more_info: "◎ Requested more information",
    note_added: "💬 Added note",
    submitted: "📋 Submission received",
  };
  return map[action] || action;
}

function carrierDetailContent(
  carrier: Record<string, unknown>,
  submissions: Record<string, unknown>[],
  docs: Record<string, unknown>[],
  notes: Record<string, unknown>[],
  activity: Record<string, unknown>[],
  success?: string,
  csrf?: string
): string {
  const latestSubmission = submissions[0] || null;
  const fmcsa = latestSubmission?.fmcsa_result as Record<string, unknown> | null;
  const flags = (latestSubmission?.internal_flags as Record<string, unknown>) || {};

  const successMessages: Record<string, string> = {
    approve: "Carrier approved.",
    conditional: "Carrier conditionally approved.",
    reject: "Carrier rejected.",
    more_info: "More information requested.",
  };

  return `
<div class="page-header">
  <div>
    <a href="/dashboard" class="back-link">← Queue</a>
    <h1 class="page-title">${h(carrier.legal_name || carrier.company_name || "Carrier")}</h1>
    <div class="page-meta">
      <code>MC${h(carrier.mc_number)}</code>
      ${carrier.dot_number ? `<span class="sep">·</span><code>DOT ${h(carrier.dot_number)}</code>` : ""}
      <span class="sep">·</span>${statusBadge(String(carrier.onboarding_status || "draft"))}
    </div>
  </div>
</div>

${success && successMessages[success] ? `<div class="alert alert-success">${successMessages[success]}</div>` : ""}

<div class="detail-grid">

  <!-- LEFT COLUMN -->
  <div class="detail-left">

    <!-- Carrier Info -->
    <div class="card">
      <div class="card-title">Carrier Information</div>
      <div class="info-grid">
        <div class="info-row"><span class="info-label">Legal Name</span><span>${h(carrier.legal_name || carrier.company_name || "—")}</span></div>
        ${carrier.dba_name ? `<div class="info-row"><span class="info-label">DBA</span><span>${h(carrier.dba_name)}</span></div>` : ""}
        <div class="info-row"><span class="info-label">MC Number</span><span><code>MC${h(carrier.mc_number)}</code></span></div>
        ${carrier.dot_number ? `<div class="info-row"><span class="info-label">DOT Number</span><span><code>${h(carrier.dot_number)}</code></span></div>` : ""}
        ${carrier.phone ? `<div class="info-row"><span class="info-label">Phone</span><span>${h(carrier.phone)}</span></div>` : ""}
        ${carrier.email ? `<div class="info-row"><span class="info-label">Email</span><span>${h(carrier.email)}</span></div>` : ""}
        ${carrier.city ? `<div class="info-row"><span class="info-label">Location</span><span>${h(carrier.city)}${carrier.state ? `, ${h(carrier.state)}` : ""}</span></div>` : ""}
        ${carrier.last_verified_at ? `<div class="info-row"><span class="info-label">Last Verified</span><span class="muted">${new Date(String(carrier.last_verified_at)).toLocaleDateString()}</span></div>` : ""}
      </div>
    </div>

    <!-- FMCSA Result -->
    ${fmcsa ? `
    <div class="card">
      <div class="card-title">FMCSA Verification</div>
      <div class="fmcsa-block">
        <div class="fmcsa-status ${fmcsa.active ? "pass" : "fail"}">
          ${fmcsa.active ? "✓ Active Authority" : "✗ Inactive / Not Authorized"}
        </div>
        <div class="info-grid" style="margin-top:12px">
          <div class="info-row"><span class="info-label">Authority</span><span>${String(fmcsa.operating_status || fmcsa.authority || "—")}</span></div>
          <div class="info-row"><span class="info-label">Safety Rating</span><span>${String(fmcsa.safety_rating || "Not Rated")}</span></div>
          ${fmcsa.years_in_operation != null ? `<div class="info-row"><span class="info-label">Years Operating</span><span>${String(fmcsa.years_in_operation)}</span></div>` : ""}
          ${fmcsa.physical_address ? `<div class="info-row"><span class="info-label">Address</span><span>${String(fmcsa.physical_address)}</span></div>` : ""}
        </div>
      </div>
    </div>` : ""}

    <!-- Internal Flags -->
    ${flags && Object.keys(flags).length > 0 ? `
    <div class="card">
      <div class="card-title">Internal Flags</div>
      ${(flags.flags as string[] || []).map((f: string) => `
        <div class="flag-item">⚠ ${f.replace(/_/g, " ")}</div>
      `).join("")}
      ${flags.auto_rejected ? `<div class="flag-item flag-auto">Auto-rejected by system rules</div>` : ""}
    </div>` : ""}

    <!-- Documents -->
    <div class="card">
      <div class="card-title">Documents</div>
      ${docs.length === 0 ? `<p class="muted" style="font-size:13px">No documents on file.</p>` : `
        <div class="doc-list">
          ${docs.map((d: Record<string, unknown>) => `
            <div class="doc-item">
              <div>
                <div class="doc-type">${docTypeLabel(String(d.document_type))}</div>
                ${d.expires_at ? `<div class="doc-expiry muted">Expires ${new Date(String(d.expires_at)).toLocaleDateString()}</div>` : ""}
              </div>
              <div class="doc-status ${d.verification_status === "verified" ? "verified" : "pending"}">
                ${d.verification_status === "verified" ? "✓ Verified" : d.verification_status || "Pending"}
              </div>
            </div>
          `).join("")}
        </div>
      `}
    </div>

  </div>

  <!-- RIGHT COLUMN -->
  <div class="detail-right">

    <!-- Decision Panel -->
    ${latestSubmission ? `
    <div class="card decision-card">
      <div class="card-title">Decision</div>
      <div class="submission-meta muted" style="margin-bottom:16px;font-size:12px">
        Submitted by ${h(latestSubmission.submitted_by_name || "—")} · ${latestSubmission.submitted_at ? new Date(String(latestSubmission.submitted_at)).toLocaleDateString() : ""}
        ${latestSubmission.reviewer_name ? ` · Reviewed by ${h(latestSubmission.reviewer_name)}` : ""}
      </div>
      ${latestSubmission.decision_reason ? `
        <div class="decision-reason">
          <div class="info-label">Previous decision</div>
          <p>${h(latestSubmission.decision_reason)}</p>
        </div>
      ` : ""}
      <form method="POST" action="/carriers/${String(carrier.id)}/decision">
        <input type="hidden" name="_csrf" value="${h(csrf)}">
        <input type="hidden" name="submission_id" value="${String(latestSubmission.id)}">
        <div class="form-field">
          <label class="field-label">Decision reason <span style="color:#ef4444">*</span></label>
          <textarea name="decision_reason" rows="3" placeholder="Notes on this decision..." required class="field-input"></textarea>
        </div>
        <div class="decision-actions">
          <button type="submit" name="action" value="approve" class="btn-decision approve">✓ Approve</button>
          <button type="submit" name="action" value="conditional" class="btn-decision conditional">⚠ Conditional</button>
          <button type="submit" name="action" value="reject" class="btn-decision reject">✗ Reject</button>
          <button type="submit" name="action" value="more_info" class="btn-decision more-info">◎ More Info</button>
        </div>
      </form>
    </div>
    ` : ""}

    <!-- Dispatch Packet -->
    ${carrier.onboarding_status !== 'rejected' && carrier.onboarding_status !== 'draft' ? `
    <div class="card" style="border-left:3px solid #C8892A">
      <div class="card-title">Dispatch</div>
      <form method="POST" action="/carriers/${String(carrier.id)}/dispatch/create">
        <input type="hidden" name="_csrf" value="${h(csrf)}">
        <input type="hidden" name="carrier_submission_id" value="${latestSubmission ? String(latestSubmission.id) : ''}">
        <div class="form-field">
          <label class="field-label">Load reference <span style="color:#ef4444">*</span></label>
          <input type="text" name="load_reference" class="field-input" placeholder="e.g. DAT-20260412-001" required>
        </div>
        <div class="form-field">
          <label class="field-label">Pickup address</label>
          <input type="text" name="pickup_address" class="field-input" placeholder="123 Main St, Phoenix AZ">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="form-field">
            <label class="field-label">Window start</label>
            <input type="text" name="pickup_window_start" class="field-input" placeholder="e.g. 04/14 08:00">
          </div>
          <div class="form-field">
            <label class="field-label">Window end</label>
            <input type="text" name="pickup_window_end" class="field-input" placeholder="e.g. 04/14 12:00">
          </div>
        </div>
        <button type="submit" class="btn-primary" style="width:100%">Open Dispatch Packet →</button>
      </form>
      <div style="margin-top:10px">
        <a href="/carriers/${String(carrier.id)}/dispatch" class="btn-link" style="font-size:12px">View dispatch history</a>
      </div>
    </div>
    ` : ''}
    <!-- Notes -->
    <div class="card" id="notes">
      <div class="card-title">Notes</div>
      <form method="POST" action="/carriers/${String(carrier.id)}/notes" style="margin-bottom:16px">
        <input type="hidden" name="_csrf" value="${h(csrf)}">
        <textarea name="body" rows="2" placeholder="Add a note..." class="field-input" style="margin-bottom:8px"></textarea>
        <button type="submit" class="btn-sm">Add Note</button>
      </form>
      ${notes.length === 0 ? `<p class="muted" style="font-size:13px">No notes yet.</p>` : `
        <div class="note-list">
          ${notes.map((n: Record<string, unknown>) => `
            <div class="note-item">
              <div class="note-author">${h(n.author_name)} <span class="note-time muted">${n.created_at ? new Date(String(n.created_at)).toLocaleDateString() : ""}</span></div>
              <p class="note-body">${h(n.body)}</p>
            </div>
          `).join("")}
        </div>
      `}
    </div>

    <!-- Activity Timeline -->
    <div class="card">
      <div class="card-title">Activity</div>
      ${activity.length === 0 ? `<p class="muted" style="font-size:13px">No activity recorded.</p>` : `
        <div class="activity-list">
          ${activity.map((a: Record<string, unknown>) => `
            <div class="activity-item">
              <div class="activity-action">${actionLabel(String(a.action))}</div>
              <div class="activity-time muted">${a.created_at ? new Date(String(a.created_at)).toLocaleString() : ""}</div>
              ${(a.metadata as Record<string, unknown>)?.reason ? `<div class="activity-meta muted">${String((a.metadata as Record<string, unknown>).reason)}</div>` : ""}
            </div>
          `).join("")}
        </div>
      `}
    </div>

  </div>
</div>`;
}
