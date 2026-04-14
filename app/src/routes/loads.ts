import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { layout } from "../views/layout";

const router = Router();
const MCP_URL = process.env.MCP_SERVER_URL || "https://cc-mcp-server-production.up.railway.app";

router.get("/loads", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userName = req.session.userName || "";
  const userRole = req.session.userRole || "";

  const html = layout({
    title: "My Loads",
    userName,
    userRole,
    content: loadsPageContent(MCP_URL),
  });

  res.send(html);
});

export default router;

function loadsPageContent(mcpUrl: string): string {
  return `
<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <h1 class="page-title">My Loads</h1>
    <p class="page-sub">Create load links, filter inbound carriers, and manage assignments.</p>
  </div>
  <a href="https://connectedcarriers.org/post-load.html" class="btn-primary" style="text-decoration:none;padding:9px 18px;font-size:13px" target="_blank">+ Create Load</a>
</div>

<div id="attention-card" class="card" style="border-left:3px solid var(--amber);display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="card-title" style="margin:0;padding:0;border:0;color:var(--amber)">What needs attention</div>
    <button onclick="refreshAttention()" style="background:none;border:1px solid var(--cream3);padding:4px 10px;border-radius:2px;font-family:var(--sans);font-size:11px;color:var(--muted);cursor:pointer">Refresh</button>
  </div>
  <div id="attention-list"></div>
</div>

<div class="card" style="padding:0">
  <div style="padding:16px 22px;border-bottom:1px solid var(--cream2);display:flex;justify-content:space-between;align-items:center">
    <div class="card-title" style="margin:0;padding:0;border:0">Your loads</div>
    <button onclick="refreshLoads()" style="background:none;border:1px solid var(--cream3);padding:5px 12px;border-radius:2px;font-family:var(--sans);font-size:12px;color:var(--muted);cursor:pointer">Refresh</button>
  </div>
  <div id="loads-list" style="min-height:100px">
    <div class="empty" style="padding:32px">Loading your loads...</div>
  </div>
</div>

<div class="card" style="margin-top:24px">
  <div class="card-title">Quick create</div>
  <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Create a load and get a shareable link for your load board postings. Carriers enter their MC and you see who's qualified.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div class="form-field"><label class="field-label">Origin</label><input class="field-input" id="qc-origin" placeholder="e.g. Tacoma, WA"></div>
    <div class="form-field"><label class="field-label">Destination</label><input class="field-input" id="qc-dest" placeholder="e.g. Dallas, TX"></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div class="form-field"><label class="field-label">Equipment</label><input class="field-input" id="qc-equip" placeholder="e.g. 53' Dry Van"></div>
    <div class="form-field"><label class="field-label">Pickup date</label><input class="field-input" id="qc-date" placeholder="e.g. April 20"></div>
  </div>
  <button class="btn-primary" onclick="quickCreate()" id="qc-btn">Create Load Link</button>
  <span id="qc-status" style="font-size:12px;color:var(--muted);margin-left:12px"></span>
  <div id="qc-result" style="display:none;margin-top:16px;background:var(--cream);border-radius:3px;padding:16px">
    <div style="font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Your load link</div>
    <div id="qc-link" style="font-size:14px;font-weight:500;color:var(--slate);word-break:break-all;margin-bottom:8px"></div>
    <button onclick="copyText(document.getElementById('qc-link').textContent)" style="background:var(--amber);color:var(--slate);border:none;padding:6px 14px;border-radius:2px;font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer;margin-right:8px">Copy Link</button>
    <a id="qc-board" href="#" target="_blank" style="font-size:12px;color:var(--amber);text-decoration:none">View applicants →</a>
  </div>
</div>

<script>
const MCP = '${mcpUrl}';

async function refreshLoads() {
  const el = document.getElementById('loads-list');
  el.innerHTML = '<div class="empty" style="padding:20px">Loading...</div>';
  try {
    const res = await fetch(MCP + '/loads/recent');
    if (!res.ok) throw new Error('No loads found');
    const data = await res.json();
    if (!data.loads || data.loads.length === 0) {
      el.innerHTML = '<div class="empty" style="padding:32px">No loads yet. Create your first load above.</div>';
      return;
    }
    el.innerHTML = '<table class="data-table"><thead><tr><th>Load ID</th><th>Route</th><th>Equipment</th><th>Status</th><th>Applicants</th><th></th></tr></thead><tbody>' +
      data.loads.map(function(l) {
        var statusColor = l.status === 'open' ? '#10b981' : l.status === 'covered' ? '#3b82f6' : '#6b7a8a';
        return '<tr>' +
          '<td><code>' + l.load_id + '</code></td>' +
          '<td style="font-weight:500">' + l.origin + ' → ' + l.destination + '</td>' +
          '<td class="muted">' + l.equipment + '</td>' +
          '<td><span class="badge" style="background:' + statusColor + '20;color:' + statusColor + ';border:1px solid ' + statusColor + '40">' + l.status + '</span></td>' +
          '<td class="muted">' + (l.applicant_count || 0) + '</td>' +
          '<td><a href="' + MCP + '/board/' + l.slug + '" target="_blank" class="btn-link">Board →</a></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  } catch(e) {
    el.innerHTML = '<div class="empty" style="padding:32px">No loads yet. Create your first load above.</div>';
  }
}

async function quickCreate() {
  var origin = document.getElementById('qc-origin').value.trim();
  var dest = document.getElementById('qc-dest').value.trim();
  var equip = document.getElementById('qc-equip').value.trim();
  var date = document.getElementById('qc-date').value.trim();
  if (!origin || !dest || !equip) { document.getElementById('qc-status').textContent = 'Origin, destination, and equipment required.'; return; }
  var btn = document.getElementById('qc-btn');
  btn.disabled = true; btn.textContent = 'Creating...';
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
    } else { throw new Error(data.error); }
  } catch(e) {
    document.getElementById('qc-status').textContent = 'Error: ' + e.message;
    document.getElementById('qc-status').style.color = '#ef4444';
  }
  btn.disabled = false; btn.textContent = 'Create Load Link';
}

function copyText(t) {
  navigator.clipboard.writeText(t).catch(function(){});
  event.target.textContent = 'Copied!';
  setTimeout(function(){ event.target.textContent = 'Copy Link'; }, 2000);
}

async function refreshAttention() {
  var card = document.getElementById('attention-card');
  var list = document.getElementById('attention-list');
  try {
    var res = await fetch(MCP + '/loads/attention');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    if (!data.items || data.items.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    list.innerHTML = data.items.map(function(item) {
      var urgencyColor = item.priority <= 1 ? '#a32d2d' : item.priority <= 2 ? '#BA7517' : '#6B7A8A';
      return '<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--cream2)">' +
        '<span style="font-size:16px;flex-shrink:0;margin-top:1px">' + item.icon + '</span>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:500;color:var(--slate)">' + item.load_id + ' <span style="font-weight:400;color:var(--muted)">— ' + item.route + '</span></div>' +
          '<div style="font-size:13px;color:' + urgencyColor + ';margin-top:2px">' + item.message + '</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + item.action + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    // remove last border
    var children = list.children;
    if (children.length > 0) children[children.length - 1].style.borderBottom = 'none';
  } catch(e) {
    card.style.display = 'none';
  }
}

refreshAttention();
refreshLoads();
</script>`;
}
