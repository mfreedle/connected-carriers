import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { layout } from "../views/layout";
import { query } from "../db";

const router = Router();
const MCP_URL = process.env.MCP_SERVER_URL || "https://cc-mcp-server-production.up.railway.app";

router.get("/loads", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userName = req.session.userName || "";
  const userRole = req.session.userRole || "";

  // Check for expiring docs across all carrier profiles
  let docAlerts: { company: string; mc: string; issue: string; severity: string }[] = [];
  try {
    const expiring = await query(`
      SELECT company_name, mc_number, insurance_expiration, cdl_expiration, doc_flags
      FROM carrier_profiles
      WHERE completion_status = 'dispatch_ready'
        AND (
          (insurance_expiration IS NOT NULL AND insurance_expiration < NOW() + INTERVAL '30 days')
          OR (cdl_expiration IS NOT NULL AND cdl_expiration < NOW() + INTERVAL '30 days')
          OR (doc_flags::text LIKE '%VIN_NOT_ON_INSURANCE%')
        )
      ORDER BY COALESCE(insurance_expiration, cdl_expiration) ASC
      LIMIT 10
    `);
    for (const row of expiring.rows) {
      const today = new Date();
      if (row.insurance_expiration) {
        const exp = new Date(row.insurance_expiration);
        if (exp < today) {
          docAlerts.push({ company: row.company_name, mc: row.mc_number, issue: "Insurance expired " + exp.toLocaleDateString(), severity: "red" });
        } else {
          const days = Math.ceil((exp.getTime() - today.getTime()) / (1000*60*60*24));
          docAlerts.push({ company: row.company_name, mc: row.mc_number, issue: `Insurance expires in ${days} days`, severity: days <= 7 ? "red" : "yellow" });
        }
      }
      if (row.cdl_expiration) {
        const exp = new Date(row.cdl_expiration);
        if (exp < today) {
          docAlerts.push({ company: row.company_name, mc: row.mc_number, issue: "CDL expired " + exp.toLocaleDateString(), severity: "red" });
        } else {
          const days = Math.ceil((exp.getTime() - today.getTime()) / (1000*60*60*24));
          if (days <= 30) docAlerts.push({ company: row.company_name, mc: row.mc_number, issue: `CDL expires in ${days} days`, severity: days <= 7 ? "red" : "yellow" });
        }
      }
      if (row.doc_flags && JSON.stringify(row.doc_flags).includes("VIN_NOT_ON_INSURANCE")) {
        docAlerts.push({ company: row.company_name, mc: row.mc_number, issue: "VIN not found on insurance policy", severity: "red" });
      }
    }
  } catch { /* table might not have new columns yet */ }

  const html = layout({
    title: "My Loads",
    userName,
    userRole,
    content: loadsPageContent(MCP_URL, docAlerts),
  });

  res.send(html);
});

export default router;

function loadsPageContent(mcpUrl: string, docAlerts: { company: string; mc: string; issue: string; severity: string }[] = []): string {
  const alertsHtml = docAlerts.length > 0 ? `
<div class="card" style="border-left:3px solid #a32d2d;margin-bottom:20px">
  <div class="card-title" style="margin:0 0 10px 0;padding:0;border:0;color:#a32d2d">Carrier doc alerts</div>
  ${docAlerts.map(a => `<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--cream2)">
    <span style="font-size:14px;flex-shrink:0">${a.severity === "red" ? "🔴" : "🟡"}</span>
    <div><span style="font-size:13px;font-weight:500;color:var(--slate)">${a.company || "Unknown"}</span><span style="color:var(--muted);font-size:12px"> · MC${a.mc || "?"}</span><div style="font-size:12px;color:${a.severity === "red" ? "#a32d2d" : "#BA7517"};margin-top:1px">${a.issue}</div></div>
  </div>`).join("")}
</div>` : "";

  return `
<div class="page-header">
  <h1 class="page-title">My Loads</h1>
  <p class="page-sub">Filter carriers, chase docs, get pickup signals — all from here.</p>
</div>

${alertsHtml}

<!-- TWO ACTION CARDS -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">

  <!-- CREATE LOAD -->
  <div class="card" id="create-card">
    <div class="card-title">Post a load</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Create a shareable link. Paste it into DAT or Truckstop. Carriers enter their MC — you see who qualifies.</p>
    <div class="form-field"><label class="field-label">Your load / BOL number</label><input class="field-input" id="qc-ref" placeholder="e.g. LX-20260414-001, BOL 94827, DAT-2026-0413"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-field"><label class="field-label">Origin</label><input class="field-input" id="qc-origin" placeholder="Tacoma, WA"></div>
      <div class="form-field"><label class="field-label">Destination</label><input class="field-input" id="qc-dest" placeholder="Dallas, TX"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-field"><label class="field-label">Equipment</label><input class="field-input" id="qc-equip" placeholder="53' Dry Van"></div>
      <div class="form-field"><label class="field-label">Pickup date</label><input class="field-input" id="qc-date" placeholder="April 20"></div>
    </div>
    <button class="btn-primary" onclick="quickCreate()" id="qc-btn" style="width:100%">Create Load Link</button>
    <div id="qc-status" style="font-size:12px;color:var(--muted);margin-top:8px;text-align:center"></div>
    <div id="qc-result" style="display:none;margin-top:12px;background:var(--cream);border-radius:3px;padding:12px">
      <div style="font-size:11px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Your load link</div>
      <div id="qc-link" style="font-size:13px;font-weight:500;color:var(--slate);word-break:break-all;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px">
        <button onclick="copyText(document.getElementById('qc-link').textContent, this)" style="background:var(--amber);color:var(--slate);border:none;padding:5px 12px;border-radius:2px;font-family:var(--sans);font-size:11px;font-weight:500;cursor:pointer">Copy Link</button>
        <a id="qc-board" href="#" target="_blank" style="font-size:11px;color:var(--amber);text-decoration:none;display:flex;align-items:center">View applicants →</a>
      </div>
    </div>
  </div>

  <!-- WHAT NEEDS ATTENTION (moved from below) -->
  <div id="attention-card" class="card" style="border-left:3px solid var(--amber)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div class="card-title" style="margin:0;padding:0;border:0;color:var(--amber)">What needs attention</div>
      <button onclick="refreshAttention()" style="background:none;border:1px solid var(--cream3);padding:4px 10px;border-radius:2px;font-family:var(--sans);font-size:11px;color:var(--muted);cursor:pointer">Refresh</button>
    </div>
    <div id="attention-list"><div style="padding:8px;font-size:12px;color:var(--muted)">Loading...</div></div>
  </div>

</div>

<!-- LOADS TABLE -->
<div class="card" style="padding:0">
  <div style="padding:14px 22px;border-bottom:1px solid var(--cream2);display:flex;justify-content:space-between;align-items:center">
    <div class="card-title" style="margin:0;padding:0;border:0">Your loads</div>
    <button onclick="refreshLoads()" style="background:none;border:1px solid var(--cream3);padding:4px 10px;border-radius:2px;font-family:var(--sans);font-size:11px;color:var(--muted);cursor:pointer">Refresh</button>
  </div>
  <div id="loads-list" style="min-height:60px">
    <div class="empty" style="padding:24px">Loading...</div>
  </div>
</div>

<script>
var MCP = '${mcpUrl}';

async function quickCreate() {
  var ref = document.getElementById('qc-ref').value.trim();
  var origin = document.getElementById('qc-origin').value.trim();
  var dest = document.getElementById('qc-dest').value.trim();
  var equip = document.getElementById('qc-equip').value.trim();
  var date = document.getElementById('qc-date').value.trim();
  if (!origin || !dest || !equip) { document.getElementById('qc-status').textContent = 'Origin, destination, and equipment required.'; document.getElementById('qc-status').style.color='#ef4444'; return; }
  var btn = document.getElementById('qc-btn');
  btn.disabled = true; btn.textContent = 'Creating...';
  document.getElementById('qc-status').textContent = '';
  try {
    var res = await fetch(MCP + '/load/create', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({origin: origin, destination: dest, equipment: equip, pickup_date: date, broker_ref: ref || undefined})
    });
    var data = await res.json();
    if (data.success) {
      document.getElementById('qc-link').textContent = data.apply_url;
      document.getElementById('qc-board').href = data.board_url;
      document.getElementById('qc-result').style.display = 'block';
      document.getElementById('qc-status').textContent = 'Load ' + data.load_id + ' created.';
      document.getElementById('qc-status').style.color = '#10b981';
      refreshLoads();
      refreshAttention();
    } else { throw new Error(data.error); }
  } catch(e) {
    document.getElementById('qc-status').textContent = 'Error: ' + e.message;
    document.getElementById('qc-status').style.color = '#ef4444';
  }
  btn.disabled = false; btn.textContent = 'Create Load Link';
}

async function refreshLoads() {
  var el = document.getElementById('loads-list');
  el.innerHTML = '<div class="empty" style="padding:20px">Loading...</div>';
  try {
    var res = await fetch(MCP + '/loads/recent');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    if (!data.loads || data.loads.length === 0) {
      el.innerHTML = '<div class="empty" style="padding:24px">No loads yet. Create your first load above.</div>';
      return;
    }
    el.innerHTML = '<table class="data-table"><thead><tr><th>Load</th><th>Route</th><th>Equipment</th><th>Pipeline</th><th></th></tr></thead><tbody>' +
      data.loads.map(function(l) {
        var pipeColors = {
          posted: {bg:'#6B7A8A',label:'Posted'},
          has_applicants: {bg:'#3b82f6',label:'Qualified'},
          ready_to_assign: {bg:'#C8892A',label:'Ready to Assign'},
          assigned: {bg:'#8b5cf6',label:'Docs Requested'},
          arrival_sent: {bg:'#2563eb',label:'Arrival Sent'},
          unresponsive: {bg:'#ef4444',label:'No Response'},
          confirmed: {bg:'#10b981',label:'Confirmed ✓'},
          review: {bg:'#f59e0b',label:'Review'},
          alert: {bg:'#ef4444',label:'Alert ⚠'},
          covered: {bg:'#10b981',label:'Covered'},
          cancelled: {bg:'#6B7A8A',label:'Cancelled'}
        };
        var p = pipeColors[l.pipeline] || {bg:'#6B7A8A',label:l.pipeline};
        var appCount = parseInt(l.applicant_count) || 0;
        var viewBtn = appCount > 0
          ? '<button onclick="toggleApplicants(\\'' + l.load_id + '\\',\\'' + l.slug + '\\')" class="btn-link" style="border:none;background:none;cursor:pointer;font-family:var(--sans)">' + appCount + ' applicant' + (appCount !== 1 ? 's' : '') + ' ▾</button>'
          : '<a href="javascript:void(0)" onclick="copyLoadLink(\\'' + MCP + '/load/' + l.slug + '\\')" class="btn-link" style="font-size:11px">Copy link</a>';
        var loadLabel = l.broker_ref
          ? '<div style="font-weight:500;font-size:13px;color:var(--slate)">' + l.broker_ref + '</div><div style="font-size:11px;color:var(--muted)"><code>' + l.load_id + '</code></div>'
          : '<code>' + l.load_id + '</code>';
        return '<tr><td>' + loadLabel + '</td><td style="font-weight:500">' + l.origin + ' → ' + l.destination + '</td><td class="muted">' + l.equipment + '</td><td><span class="badge" style="background:' + p.bg + '20;color:' + p.bg + ';border:1px solid ' + p.bg + '40">' + p.label + '</span><div style="font-size:11px;color:var(--muted);margin-top:2px">' + (l.pipeline_detail || '') + '</div></td><td>' + viewBtn + '</td></tr>' +
          '<tr id="apps-' + l.load_id + '" style="display:none"><td colspan="5" style="padding:0;background:var(--cream)"><div id="apps-content-' + l.load_id + '" style="padding:12px 16px"></div></td></tr>';
      }).join('') + '</tbody></table>';
  } catch(e) {
    el.innerHTML = '<div class="empty" style="padding:24px">No loads yet. Create your first load above.</div>';
  }
}

async function refreshAttention() {
  var card = document.getElementById('attention-card');
  var list = document.getElementById('attention-list');
  card.style.display = 'block';
  list.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Refreshing...</div>';
  try {
    var res = await fetch(MCP + '/loads/attention');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    if (!data.items || data.items.length === 0) { 
      list.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Nothing needs attention right now.</div>';
      return; 
    }
    list.innerHTML = data.items.map(function(item) {
      var uc = item.priority <= 1 ? '#a32d2d' : item.priority <= 2 ? '#BA7517' : '#6B7A8A';
      return '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--cream2)"><span style="font-size:15px;flex-shrink:0;margin-top:1px">' + item.icon + '</span><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;color:var(--slate)">' + item.load_id + ' <span style="font-weight:400;color:var(--muted)">— ' + item.route + '</span></div><div style="font-size:12px;color:' + uc + ';margin-top:1px">' + item.message + '</div></div></div>';
    }).join('');
    var ch = list.children;
    if (ch.length > 0) ch[ch.length - 1].style.borderBottom = 'none';
  } catch(e) { 
    list.innerHTML = '<div style="padding:8px;font-size:12px;color:#a32d2d">Could not load — try again.</div>';
  }
}

function copyText(t, el) {
  navigator.clipboard.writeText(t).catch(function(){});
  el.textContent = 'Copied!';
  setTimeout(function(){ el.textContent = 'Copy Link'; }, 2000);
}

function copyLoadLink(url) {
  navigator.clipboard.writeText(url).catch(function(){});
}

async function toggleApplicants(loadId, slug) {
  var row = document.getElementById('apps-' + loadId);
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }
  row.style.display = '';
  var content = document.getElementById('apps-content-' + loadId);
  content.innerHTML = '<div style="font-size:12px;color:var(--muted)">Loading applicants...</div>';
  try {
    var res = await fetch(MCP + '/loads/' + loadId + '/applicants');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    if (!data.applicants || data.applicants.length === 0) {
      content.innerHTML = '<div style="font-size:12px;color:var(--muted)">No qualified applicants yet.</div>';
      return;
    }
    content.innerHTML = data.applicants.map(function(a) {
      var profileBadge = a.has_profile
        ? '<span style="background:#EAF3DE;color:#3b6d11;padding:2px 6px;border-radius:2px;font-size:10px;font-weight:600">DISPATCH READY</span>'
        : '<span style="background:#F0EDE7;color:#6b7a8a;padding:2px 6px;border-radius:2px;font-size:10px;font-weight:600">NEEDS DOCS</span>';
      var contactInfo = a.contact_name ? (a.contact_name + (a.contact_phone ? ' · ' + a.contact_phone : '')) : '';
      return '<div style="border-bottom:1px solid var(--cream2);padding-bottom:8px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:500;color:var(--slate)">' + (a.company_name || 'MC' + a.mc_number) + ' <span style="font-size:11px;color:var(--muted)">MC' + a.mc_number + '</span></div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + a.fmcsa_authority + ' · Safety: ' + a.fmcsa_safety + ' ' + profileBadge + '</div>' +
            (contactInfo ? '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + contactInfo + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<button onclick="toggleProfile(\\'' + a.mc_number + '\\',this)" style="padding:4px 10px;background:none;border:1px solid var(--cream3);border-radius:2px;font-size:10px;font-family:var(--sans);color:var(--muted);cursor:pointer">Profile ▾</button>' +
            '<input type="tel" id="aphone-' + a.id + '" value="' + (a.contact_phone || '') + '" placeholder="Driver phone" style="padding:4px 8px;border:1px solid var(--cream3);border-radius:2px;font-size:11px;width:110px">' +
            '<button onclick="assignFromDashboard(\\'' + slug + '\\',' + a.id + ',document.getElementById(\\'aphone-' + a.id + '\\').value,\\'' + (a.company_name || '').replace(/'/g, '') + '\\')" style="padding:5px 12px;background:var(--amber);color:var(--slate);border:none;border-radius:2px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap">' + (a.has_profile ? 'Assign → Check' : 'Assign → Docs') + '</button>' +
          '</div>' +
        '</div>' +
        '<div id="profile-' + a.mc_number + '" style="display:none"></div>' +
      '</div>';
    }).join('');
  } catch(e) {
    content.innerHTML = '<div style="font-size:12px;color:#a32d2d">Error loading applicants.</div>';
  }
}

async function toggleProfile(mc, btn) {
  var el = document.getElementById('profile-' + mc);
  if (el.style.display !== 'none') { el.style.display = 'none'; btn.textContent = 'Profile ▾'; return; }
  el.style.display = 'block';
  btn.textContent = 'Profile ▴';
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0">Loading profile...</div>';
  try {
    var res = await fetch(MCP + '/carrier/' + mc + '/profile');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    if (!data.found) {
      el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0;background:#fff;border-radius:3px;padding:10px;margin-top:6px">No carrier profile on file. Carrier hasn\\'t submitted docs yet.</div>';
      return;
    }
    var p = data.profile;
    var insExp = p.insurance_expiration ? new Date(p.insurance_expiration) : null;
    var cdlExp = p.cdl_expiration ? new Date(p.cdl_expiration) : null;
    var now = new Date();
    var insExpired = insExp && insExp < now;
    var cdlExpired = cdlExp && cdlExp < now;
    var vinFlag = p.doc_flags && JSON.stringify(p.doc_flags).includes('VIN_NOT_ON_INSURANCE');

    el.innerHTML = '<div style="background:#fff;border:1px solid var(--cream3);border-radius:3px;padding:12px;margin-top:6px;font-size:12px">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<div>' +
          (p.driver_name ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px">Driver</div><div style="font-weight:500">' + p.driver_name + (p.driver_phone ? ' · ' + p.driver_phone : '') + '</div>' : '') +
          (p.truck_number ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-top:8px;margin-bottom:2px">Truck / Trailer</div><div>#' + p.truck_number + (p.trailer_number ? ' / #' + p.trailer_number : '') + '</div>' : '') +
          (p.vin_number ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-top:8px;margin-bottom:2px">VIN</div><div style="font-family:monospace;letter-spacing:0.04em">' + p.vin_number + (vinFlag ? ' <span style="color:#a32d2d;font-weight:500">⚠ NOT ON INSURANCE</span>' : '') + '</div>' : '') +
        '</div>' +
        '<div>' +
          (p.cdl_number ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px">CDL</div><div>' + p.cdl_number + (p.cdl_state ? ' (' + p.cdl_state + ')' : '') + (cdlExp ? ' · Exp ' + cdlExp.toLocaleDateString() + (cdlExpired ? ' <span style="color:#a32d2d;font-weight:500">EXPIRED</span>' : '') : '') + '</div>' : '') +
          (p.insurance_company ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-top:8px;margin-bottom:2px">Insurance</div><div>' + p.insurance_company + (p.insurance_policy_number ? ' · #' + p.insurance_policy_number : '') + (insExp ? ' · Exp ' + insExp.toLocaleDateString() + (insExpired ? ' <span style="color:#a32d2d;font-weight:500">EXPIRED</span>' : '') : '') + '</div>' : '') +
          (p.insurance_auto_liability ? '<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-top:8px;margin-bottom:2px">Coverage</div><div>Auto $' + (p.insurance_auto_liability/1000000).toFixed(1) + 'M · Cargo $' + ((p.insurance_cargo||0)/1000) + 'K · GL $' + ((p.insurance_general_liability||0)/1000000).toFixed(1) + 'M</div>' : '') +
        '</div>' +
      '</div>' +
      '<div style="margin-top:10px;display:flex;gap:8px">' +
        (p.cdl_photo_url ? '<a href="' + p.cdl_photo_url + '" target="_blank" style="padding:3px 8px;background:var(--cream);border:1px solid var(--cream3);border-radius:2px;font-size:10px;color:var(--slate);text-decoration:none">View CDL</a>' : '<span style="font-size:10px;color:#a32d2d">No CDL</span>') +
        (p.vin_photo_url ? '<a href="' + p.vin_photo_url + '" target="_blank" style="padding:3px 8px;background:var(--cream);border:1px solid var(--cream3);border-radius:2px;font-size:10px;color:var(--slate);text-decoration:none">View VIN</a>' : '<span style="font-size:10px;color:#a32d2d">No VIN photo</span>') +
        (p.insurance_doc_url ? '<a href="' + p.insurance_doc_url + '" target="_blank" style="padding:3px 8px;background:var(--cream);border:1px solid var(--cream3);border-radius:2px;font-size:10px;color:var(--slate);text-decoration:none">View Insurance</a>' : '<span style="font-size:10px;color:#a32d2d">No insurance</span>') +
      '</div>' +
    '</div>';
  } catch(e) {
    el.innerHTML = '<div style="font-size:11px;color:#a32d2d;padding:6px 0">Error loading profile.</div>';
  }
}

async function assignFromDashboard(slug, appId, phone, name) {
  if (!phone || !phone.trim()) { alert('Enter the driver phone number.'); return; }
  var btn = event.target;
  btn.disabled = true; btn.textContent = 'Assigning...';
  try {
    var res = await fetch(MCP + '/load/' + slug + '/assign', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({applicant_id: appId, driver_phone: phone.trim()})
    });
    var data = await res.json();
    if (data.assigned) {
      btn.textContent = 'Assigned ✓';
      btn.style.background = '#10b981';
      btn.style.color = '#fff';
      refreshLoads();
      refreshAttention();
    } else {
      btn.textContent = data.error || 'Error';
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}

refreshAttention();
refreshLoads();
</script>`;
}
