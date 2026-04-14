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

  <!-- SEND ARRIVAL CHECK -->
  <div class="card" id="arrival-card">
    <div class="card-title">Send arrival check</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Send a text to the driver. When they arrive, you get a signal — green, yellow, or red — based on time and location.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-field"><label class="field-label">Driver phone</label><input class="field-input" id="ac-driver" placeholder="509-555-1212"></div>
      <div class="form-field"><label class="field-label">Your phone</label><input class="field-input" id="ac-broker" placeholder="Your cell"></div>
    </div>
    <div class="form-field"><label class="field-label">Pickup address</label><input class="field-input" id="ac-address" placeholder="420 Industrial Rd, Tacoma, WA"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-field"><label class="field-label">Window opens</label><input class="field-input" id="ac-start" placeholder="1:00 PM"></div>
      <div class="form-field"><label class="field-label">MC (optional)</label><input class="field-input" id="ac-mc" placeholder="MC-123456"></div>
    </div>
    <button class="btn-primary" onclick="sendArrival()" id="ac-btn" style="width:100%;background:var(--slate);color:var(--cream)">Send Arrival Check</button>
    <div id="ac-status" style="font-size:12px;color:var(--muted);margin-top:8px;text-align:center"></div>
  </div>

</div>

<!-- ATTENTION CARD -->
<div id="attention-card" class="card" style="border-left:3px solid var(--amber);display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="card-title" style="margin:0;padding:0;border:0;color:var(--amber)">What needs attention</div>
    <button onclick="refreshAttention()" style="background:none;border:1px solid var(--cream3);padding:4px 10px;border-radius:2px;font-family:var(--sans);font-size:11px;color:var(--muted);cursor:pointer">Refresh</button>
  </div>
  <div id="attention-list"></div>
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
      body: JSON.stringify({origin: origin, destination: dest, equipment: equip, pickup_date: date})
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

async function sendArrival() {
  var driver = document.getElementById('ac-driver').value.trim();
  var broker = document.getElementById('ac-broker').value.trim();
  var address = document.getElementById('ac-address').value.trim();
  var start = document.getElementById('ac-start').value.trim();
  var mc = document.getElementById('ac-mc').value.trim();
  if (!driver || !broker || !address) { document.getElementById('ac-status').textContent = 'Driver phone, your phone, and pickup address required.'; document.getElementById('ac-status').style.color='#ef4444'; return; }
  var btn = document.getElementById('ac-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  document.getElementById('ac-status').textContent = '';
  try {
    var res = await fetch(MCP + '/dispatch', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({driver_phone: driver, broker_phone: broker, pickup_address: address, pickup_window_start: start, mc_number: mc || undefined})
    });
    var data = await res.json();
    if (data.success) {
      var msg = data.sms_sent ? 'Arrival check sent to driver.' : 'Created (SMS delivery pending — Twilio approval in progress).';
      document.getElementById('ac-status').textContent = msg + ' Load: ' + data.load_id;
      document.getElementById('ac-status').style.color = '#10b981';
      document.getElementById('ac-driver').value = '';
      document.getElementById('ac-address').value = '';
      document.getElementById('ac-mc').value = '';
      refreshAttention();
    } else { throw new Error(data.error); }
  } catch(e) {
    document.getElementById('ac-status').textContent = 'Error: ' + e.message;
    document.getElementById('ac-status').style.color = '#ef4444';
  }
  btn.disabled = false; btn.textContent = 'Send Arrival Check';
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
    el.innerHTML = '<table class="data-table"><thead><tr><th>Load ID</th><th>Route</th><th>Equipment</th><th>Pipeline</th><th></th></tr></thead><tbody>' +
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
        return '<tr><td><code>' + l.load_id + '</code></td><td style="font-weight:500">' + l.origin + ' → ' + l.destination + '</td><td class="muted">' + l.equipment + '</td><td><span class="badge" style="background:' + p.bg + '20;color:' + p.bg + ';border:1px solid ' + p.bg + '40">' + p.label + '</span><div style="font-size:11px;color:var(--muted);margin-top:2px">' + (l.pipeline_detail || '') + '</div></td><td><a href="' + MCP + '/board/' + l.slug + '" target="_blank" class="btn-link">Board →</a></td></tr>';
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

refreshAttention();
refreshLoads();
</script>`;
}
