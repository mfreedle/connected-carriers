import { Router, Response } from "express";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { h } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

router.get("/dashboard", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const tab = (req.query.tab as string) || "all";

  const statusFilter: Record<string, string> = {
    new: "submitted",
    review: "under_review",
    approved: "approved",
    conditional: "conditional",
    rejected: "rejected",
  };

  const whereStatus = statusFilter[tab]
    ? `AND cs.status = '${statusFilter[tab]}'`
    : "";

  try {
    const result = await query(`
      SELECT
        cs.id as submission_id,
        cs.status,
        cs.submitted_at,
        cs.reviewed_at,
        cs.decision_reason,
        cs.fmcsa_result,
        cs.internal_flags,
        cs.submitted_by_name,
        cs.submitted_by_email,
        c.id as carrier_id,
        c.legal_name,
        c.company_name,
        c.mc_number,
        c.approval_tier,
        c.onboarding_status,
        c.authority_status,
        c.safety_rating_snapshot,
        bu.name as reviewer_name
      FROM carrier_submissions cs
      LEFT JOIN carriers c ON c.id = cs.carrier_id
      LEFT JOIN broker_users bu ON bu.id = cs.reviewed_by
      WHERE cs.broker_account_id = $1
      ${whereStatus}
      ORDER BY cs.submitted_at DESC
      LIMIT 100
    `, [accountId]);

    const counts = await query(`
      SELECT status, COUNT(*) as count
      FROM carrier_submissions
      WHERE broker_account_id = $1
      GROUP BY status
    `, [accountId]);

    const countMap: Record<string, number> = {};
    counts.rows.forEach((r: { status: string; count: string }) => {
      countMap[r.status] = parseInt(r.count);
    });
    const totalCount = Object.values(countMap).reduce((a, b) => a + b, 0);

    const html = layout({
      title: "Submission Queue",
      userName: req.session.userName || "",
      content: dashboardContent(result.rows, tab, countMap, totalCount),
    });

    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dashboard");
  }
});

export default router;

function statusBadge(status: string): string {
  const map: Record<string, { label: string; color: string }> = {
    submitted:          { label: "New",          color: "#3b82f6" },
    under_review:       { label: "Under Review",  color: "#f59e0b" },
    approved:           { label: "Approved",      color: "#10b981" },
    conditional:        { label: "Conditional",   color: "#f97316" },
    rejected:           { label: "Rejected",      color: "#ef4444" },
    more_info_requested:{ label: "More Info",     color: "#8b5cf6" },
  };
  const s = map[status] || { label: status, color: "#6b7a8a" };
  return `<span class="badge" style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}40">${s.label}</span>`;
}

function tierBadge(tier: string): string {
  const map: Record<string, string> = {
    preferred: "★ Preferred",
    approved: "✓ Approved",
    conditional: "⚠ Conditional",
    rejected: "✗ Rejected",
    manual_review: "◎ Review",
  };
  return map[tier] || tier;
}

function fmcsaSummary(fmcsa: Record<string, unknown> | null): string {
  if (!fmcsa) return '<span class="muted">No FMCSA data</span>';
  const active = fmcsa.active ? "✓ Active" : "✗ Inactive";
  const rating = String(fmcsa.safety_rating || "Not Rated");
  const years = fmcsa.years_in_operation != null ? `${fmcsa.years_in_operation}y` : "";
  const color = fmcsa.active ? "#10b981" : "#ef4444";
  return `<span style="color:${color};font-weight:500">${active}</span> · ${rating}${years ? ` · ${years}` : ""}`;
}

function tabCount(countMap: Record<string, number>, key: string, status: string): string {
  const n = status === "all"
    ? Object.values(countMap).reduce((a, b) => a + b, 0)
    : (countMap[status] || 0);
  return n > 0 ? ` <span class="tab-count">${n}</span>` : "";
}

function dashboardContent(
  rows: Record<string, unknown>[],
  activeTab: string,
  countMap: Record<string, number>,
  totalCount: number
): string {
  const tabs = [
    { key: "all",        label: "All",          status: "all" },
    { key: "new",        label: "New",          status: "submitted" },
    { key: "review",     label: "Under Review", status: "under_review" },
    { key: "approved",   label: "Approved",     status: "approved" },
    { key: "conditional",label: "Conditional",  status: "conditional" },
    { key: "rejected",   label: "Rejected",     status: "rejected" },
  ];

  return `
<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <h1 class="page-title">Carrier Queue</h1>
    <p class="page-sub">${totalCount} submission${totalCount !== 1 ? "s" : ""} total</p>
  </div>
  <a href="/intake/links" class="btn-primary" style="text-decoration:none;padding:9px 18px;font-size:13px">+ New Carrier Intake</a>
</div>

<div class="tabs">
  ${tabs.map(t => `
    <a href="/dashboard?tab=${t.key}" class="tab ${activeTab === t.key ? "active" : ""}">
      ${t.label}${tabCount(countMap, t.key, t.status)}
    </a>
  `).join("")}
</div>

<div class="table-wrap">
  ${rows.length === 0 ? `<div class="empty">No submissions in this category.</div>` : `
  <table class="data-table">
    <thead>
      <tr>
        <th>Carrier</th>
        <th>MC #</th>
        <th>Submitted</th>
        <th>FMCSA</th>
        <th>Status</th>
        <th>Tier</th>
        <th>Reviewer</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r: Record<string, unknown>) => `
        <tr>
          <td>
            <div class="carrier-name">${h(r.legal_name || r.company_name || r.submitted_by_name || "—")}</div>
            <div class="carrier-contact muted">${h(r.submitted_by_email || "")}</div>
          </td>
          <td><code>MC${h(r.mc_number || "—")}</code></td>
          <td class="muted">${r.submitted_at ? new Date(String(r.submitted_at)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</td>
          <td class="fmcsa-cell">${fmcsaSummary(r.fmcsa_result as Record<string, unknown> | null)}</td>
          <td>${statusBadge(String(r.status))}</td>
          <td class="tier-cell">${tierBadge(String(r.approval_tier || "manual_review"))}</td>
          <td class="muted">${h(r.reviewer_name || "—")}</td>
          <td><a href="/carriers/${r.carrier_id}" class="btn-link">Review →</a></td>
        </tr>
      `).join("")}
    </tbody>
  </table>
  `}
</div>`;
}
