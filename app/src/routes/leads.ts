import { Router, Response } from "express";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { h, csrfToken } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

// ── GET /leads ────────────────────────────────────────────────────

router.get("/leads", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const tab = (req.query.tab as string) || "broker";

  const brokerRes = await query(`
    SELECT bi.*, bu.name as reviewed_by_name
    FROM broker_interest_submissions bi
    LEFT JOIN broker_users bu ON bu.id = bi.reviewed_by
    ORDER BY bi.created_at DESC LIMIT 100
  `);

  const carrierRes = await query(`
    SELECT ci.*, bu.name as reviewed_by_name
    FROM carrier_interest_submissions ci
    LEFT JOIN broker_users bu ON bu.id = ci.reviewed_by
    ORDER BY ci.created_at DESC LIMIT 100
  `);

  const brokerNew = brokerRes.rows.filter((r: Record<string,unknown>) => r.status === "new").length;
  const carrierNew = carrierRes.rows.filter((r: Record<string,unknown>) => r.status === "new").length;

  const csrf = csrfToken(req);
  const html = layout({
    title: "Leads",
    userName: req.session.userName || "",
    userRole: req.session.userRole,
    csrfToken: csrf,
    content: leadsContent(brokerRes.rows, carrierRes.rows, tab, brokerNew, carrierNew, csrf, req.query),
  });
  res.send(html);
});

// ── POST /leads/broker/:id/review ─────────────────────────────────

router.post("/leads/broker/:id/review", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { status } = req.body;
  const userId = req.session.userId;
  if (!["reviewed", "contacted", "rejected"].includes(status)) {
    return res.redirect("/leads?tab=broker&error=invalid_status");
  }
  await query(`
    UPDATE broker_interest_submissions SET status=$1, reviewed_at=NOW(), reviewed_by=$2 WHERE id=$3
  `, [status, userId, req.params.id]);
  res.redirect("/leads?tab=broker&saved=1");
});

// ── POST /leads/carrier/:id/review ────────────────────────────────

router.post("/leads/carrier/:id/review", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { status } = req.body;
  const userId = req.session.userId;
  if (!["reviewed", "contacted", "rejected"].includes(status)) {
    return res.redirect("/leads?tab=carrier&error=invalid_status");
  }
  await query(`
    UPDATE carrier_interest_submissions SET status=$1, reviewed_at=NOW(), reviewed_by=$2 WHERE id=$3
  `, [status, userId, req.params.id]);
  res.redirect("/leads?tab=carrier&saved=1");
});

export default router;

// ── View ──────────────────────────────────────────────────────────

function leadsContent(
  brokerLeads: Record<string,unknown>[],
  carrierLeads: Record<string,unknown>[],
  tab: string,
  brokerNew: number,
  carrierNew: number,
  csrf: string,
  qs: Record<string,unknown>
): string {
  const ts = (v: unknown) => v ? new Date(String(v)).toLocaleDateString() : "—";

  const statusBadge = (s: string) => {
    const map: Record<string,{label:string;color:string}> = {
      new:       { label: "New",       color: "#f59e0b" },
      reviewed:  { label: "Reviewed",  color: "#3b82f6" },
      contacted: { label: "Contacted", color: "#10b981" },
      rejected:  { label: "Rejected",  color: "#6b7a8a" },
    };
    const s2 = map[s] || { label: s, color: "#6b7a8a" };
    return `<span class="badge" style="background:${s2.color}20;color:${s2.color};border:1px solid ${s2.color}40">${s2.label}</span>`;
  };

  const brokerRows = brokerLeads.map(r => `
    <tr>
      <td>
        <div style="font-weight:500;font-size:13px">${h(r.company_name)}</div>
        <div class="muted" style="font-size:11px">${h(r.tms || "—")}</div>
      </td>
      <td>
        <div style="font-size:13px">${h(r.contact_name)}</div>
        <div class="muted" style="font-size:11px">${h(r.email)}</div>
        ${r.phone ? `<div class="muted" style="font-size:11px">${h(r.phone)}</div>` : ""}
      </td>
      <td style="font-size:12px;max-width:200px">
        ${r.estimated_load_volume ? `<div>${h(r.estimated_load_volume)}</div>` : ""}
        ${r.freight_profile_or_lanes ? `<div class="muted">${h(r.freight_profile_or_lanes)}</div>` : ""}
      </td>
      <td class="muted" style="font-size:12px">${ts(r.created_at)}</td>
      <td>${statusBadge(String(r.status))}</td>
      <td>
        <details style="font-size:12px">
          <summary class="btn-link" style="cursor:pointer">Actions</summary>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
            ${r.notes ? `<div style="font-size:11px;color:var(--muted);padding:6px;background:#F7F5F0;border-radius:2px;margin-bottom:4px">${h(r.notes)}</div>` : ""}
            <form method="POST" action="/leads/broker/${h(r.id)}/review" style="display:flex;gap:6px;flex-wrap:wrap">
              <input type="hidden" name="_csrf" value="${h(csrf)}">
              <button name="status" value="reviewed" class="btn-sm">Mark reviewed</button>
              <button name="status" value="contacted" class="btn-sm" style="background:#10b981;color:white">Contacted</button>
              <button name="status" value="rejected" class="btn-sm" style="background:#ef444420;color:#ef4444">Reject</button>
            </form>
          </div>
        </details>
      </td>
    </tr>`).join("");

  const carrierRows = carrierLeads.map(r => {
    const eqTypes = (() => { try { return (JSON.parse(String(r.equipment_types)) as string[]).join(", "); } catch { return ""; } })();
    return `
    <tr>
      <td>
        <div style="font-weight:500;font-size:13px">${h(r.company_name)}</div>
        ${r.mc_number ? `<div class="muted" style="font-size:11px">MC${h(r.mc_number)}</div>` : ""}
      </td>
      <td>
        <div style="font-size:13px">${h(r.contact_name)}</div>
        <div class="muted" style="font-size:11px">${h(r.email)}</div>
        ${r.phone ? `<div class="muted" style="font-size:11px">${h(r.phone)}</div>` : ""}
      </td>
      <td style="font-size:12px;max-width:200px">
        ${eqTypes ? `<div>${h(eqTypes)}</div>` : ""}
        ${r.lanes_or_regions ? `<div class="muted">${h(r.lanes_or_regions)}</div>` : ""}
      </td>
      <td class="muted" style="font-size:12px">${ts(r.created_at)}</td>
      <td>${statusBadge(String(r.status))}</td>
      <td>
        <details style="font-size:12px">
          <summary class="btn-link" style="cursor:pointer">Actions</summary>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
            ${r.notes ? `<div style="font-size:11px;color:var(--muted);padding:6px;background:#F7F5F0;border-radius:2px;margin-bottom:4px">${h(r.notes)}</div>` : ""}
            <form method="POST" action="/leads/carrier/${h(r.id)}/review" style="display:flex;gap:6px;flex-wrap:wrap">
              <input type="hidden" name="_csrf" value="${h(csrf)}">
              <button name="status" value="reviewed" class="btn-sm">Mark reviewed</button>
              <button name="status" value="contacted" class="btn-sm" style="background:#10b981;color:white">Contacted</button>
              <button name="status" value="rejected" class="btn-sm" style="background:#ef444420;color:#ef4444">Reject</button>
            </form>
            ${r.mc_number ? `
              <a href="https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${h(r.mc_number)}"
                 target="_blank" rel="noopener" class="btn-link" style="font-size:11px">FMCSA lookup →</a>` : ""}
          </div>
        </details>
      </td>
    </tr>`;
  }).join("");

  return `
<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <h1 class="page-title">Leads</h1>
    <p class="page-sub">Inbound interest from broker and carrier forms.</p>
  </div>
</div>

${qs.saved ? `<div class="alert alert-success">Status updated.</div>` : ""}
${qs.error ? `<div class="alert alert-error">Error: ${h(String(qs.error)).replace(/_/g," ")}.</div>` : ""}

<div style="display:flex;gap:0;margin-bottom:24px;border-bottom:2px solid var(--cream3)">
  <a href="/leads?tab=broker" style="padding:10px 20px;font-size:13px;font-weight:500;text-decoration:none;border-bottom:${tab==="broker"?"2px solid #C8892A":"2px solid transparent"};color:${tab==="broker"?"#1C2B3A":"#6B7A8A"};margin-bottom:-2px">
    Broker Interest ${brokerNew > 0 ? `<span class="badge" style="background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40;margin-left:6px">${brokerNew} new</span>` : ""}
  </a>
  <a href="/leads?tab=carrier" style="padding:10px 20px;font-size:13px;font-weight:500;text-decoration:none;border-bottom:${tab==="carrier"?"2px solid #C8892A":"2px solid transparent"};color:${tab==="carrier"?"#1C2B3A":"#6B7A8A"};margin-bottom:-2px">
    Carrier Interest ${carrierNew > 0 ? `<span class="badge" style="background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40;margin-left:6px">${carrierNew} new</span>` : ""}
  </a>
</div>

${tab === "broker" ? `
<div class="table-wrap">
  ${brokerLeads.length === 0 ? `<div class="empty">No broker interest submissions yet.</div>` : `
  <table class="data-table">
    <thead><tr><th>Company</th><th>Contact</th><th>Volume / Freight</th><th>Date</th><th>Status</th><th></th></tr></thead>
    <tbody>${brokerRows}</tbody>
  </table>`}
</div>` : `
<div class="table-wrap">
  ${carrierLeads.length === 0 ? `<div class="empty">No carrier interest submissions yet.</div>` : `
  <table class="data-table">
    <thead><tr><th>Company</th><th>Contact</th><th>Equipment / Lanes</th><th>Date</th><th>Status</th><th></th></tr></thead>
    <tbody>${carrierRows}</tbody>
  </table>`}
</div>`}`;
}
