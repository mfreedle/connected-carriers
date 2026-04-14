# Connected Carriers — Project Handoff
**Last updated:** April 13, 2026 (evening)
**Status:** Full three-layer product built and deployed — Filter (load apply), Chase (auto-doc request), Signal (arrival check). Stripe billing live. DNS on Cloudflare. Waiting on Twilio A2P approval for SMS delivery.

---

## 1. PRODUCT STATUS

| Stage | Status |
|-------|--------|
| Homepage + messaging | ✅ Locked — Filter. Chase. Signal. |
| Load Apply (inbound filter) | ✅ Live — carriers enter MC, instant qualification |
| Arrival Check (pickup signal) | ✅ Live — geofence gate, GPS required, broker alerts |
| Auto-chase nudge system | ✅ Wired — 10-min cadence, 2 max, blocked on Twilio |
| Assign pipeline | ✅ Built — profile check → auto-sends docs or arrival check |
| Broker dashboard + My Loads | ✅ Live — loads, applicants, assign, attention summary |
| Pricing page + Stripe billing | ✅ Live — $99/mo, $999/yr, 30-day trial |
| Pilot user system | ✅ Built — Kate gets free access via PILOT_EMAILS |
| DNS (Cloudflare) | ✅ Active — connectedcarriers.org + www |
| SMS delivery | ⏳ Blocked on Twilio A2P approval (5-7 days) |
| Production hardened | ❌ Not yet — security review deferred |

---

## 2. URLS — COMPLETE MAP

### Public pages (connectedcarriers.org — Railway via Cloudflare)
| Page | URL | Purpose |
|------|-----|---------|
| Homepage | connectedcarriers.org | Three-layer messaging, dual CTAs |
| Pricing | connectedcarriers.org/pricing.html | $99/mo, $999/yr, Stripe checkout |
| Dispatch verification | connectedcarriers.org/dispatch.html | Manual arrival check tool |
| Post a Load | connectedcarriers.org/post-load.html | Create load links for load boards |
| About | connectedcarriers.org/about.html | Three-layer product description |
| Privacy | connectedcarriers.org/privacy.html | Updated with FMCSA, Twilio, Stripe specifics |
| Terms | connectedcarriers.org/terms.html | Includes billing section, WA governing law |
| Contact | connectedcarriers.org/contact.html | Email + direct broker/carrier action links |

### Broker dashboard (app.connectedcarriers.org — Railway)
| Page | URL | Purpose |
|------|-----|---------|
| Login | app.connectedcarriers.org/login | Broker auth |
| Dashboard | app.connectedcarriers.org/dashboard | Carrier submission queue |
| My Loads | app.connectedcarriers.org/loads | Load management + "What needs attention?" |
| Billing | app.connectedcarriers.org/billing | Plan status, trial, Manage Billing |
| Carrier profile | app.connectedcarriers.org/profile/carrier | Public carrier profile submission |
| Broker interest | app.connectedcarriers.org/interest/broker | Request broker access |
| Carrier interest | app.connectedcarriers.org/interest/carrier | Carrier interest form |

### MCP server (cc-mcp-server-production.up.railway.app)
| Endpoint | Purpose |
|----------|---------|
| POST /dispatch | Create arrival check |
| GET /verify/:token | Driver confirmation page |
| GET /status/:load_id | Check verification status |
| POST /load/create | Create load with shareable link |
| GET /load/:slug | Carrier-facing apply page (MC check) |
| POST /load/:slug/check | FMCSA qualification check |
| POST /load/:slug/interest | Carrier submits contact info |
| GET /loads/recent | List recent loads with applicant counts |
| GET /loads/attention | Prioritized action items for broker |
| GET /loads/:load_id/applicants | Qualified carriers for a load |
| POST /load/:slug/assign | Assign carrier → auto doc request or arrival check |
| GET /board/:slug | Broker load board (see + assign applicants) |

---

## 3. DNS — CURRENT STATE

**Domain:** connectedcarriers.org
**Registrar:** GoDaddy (registration only)
**DNS:** Cloudflare (active, nameservers: laylah.ns.cloudflare.com, michael.ns.cloudflare.com)
**CNAME flattening:** Yes — root domain CNAME to Railway via Cloudflare

| Record | Type | Target | Service |
|--------|------|--------|---------|
| @ (root) | CNAME | z5e2xbky.up.railway.app | Landing page (Railway, one-click Cloudflare setup) |
| www | CNAME | Railway target (one-click) | Landing page |
| app | CNAME | 6uvq6g6m.up.railway.app | Broker dashboard |
| _railway-verify | TXT | railway-verify=df49... | Railway domain verification |
| MX (5 records) | MX | aspmx.l.google.com etc. | Google Workspace email |
| SPF | TXT | v=spf1 include:... | Email authentication |
| DKIM | CNAME | _domaincon... | Email authentication |
| DMARC | TXT | v=DMARC1; p=quarantine | Email authentication |

**Previous state (before today):** GoDaddy forwarding via AWS Global Accelerator IPs (3.33.251.168, 15.197.225.128) → caused relative link issues. Now fully resolved with Cloudflare CNAME flattening.

---

## 4. INFRASTRUCTURE

### Railway Services
| Service | Domain | Status |
|---------|--------|--------|
| Landing page | connectedcarriers.org / www.connectedcarriers.org | Online ✅ |
| Broker dashboard | app.connectedcarriers.org | Online ✅ |
| MCP server | cc-mcp-server-production.up.railway.app | Online ✅ |
| Postgres | internal | Online ✅ |
| R2 storage | connected-carriers-docs (Cloudflare) | Configured ✅ |

### Environment variables on broker dashboard (GitHub Repo service)
- SESSION_SECRET
- DATABASE_URL
- NODE_ENV=production
- TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
- STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
- STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL
- STRIPE_WEBHOOK_SECRET
- PILOT_EMAILS (kate@logisticsxpress.com)
- MCP_SERVER_URL (optional — defaults to cc-mcp-server-production.up.railway.app)

### Environment variables on MCP server
- DATABASE_URL
- TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
- GOOGLE_GEOCODE_KEY
- BASE_URL

### VPS Agent Listener
- VPS: root@137.184.36.72 (SSH key auth)
- Service: cc_slack_listener — RUNNING
- Env: /home/connected-carriers/.env

---

## 5. STRIPE BILLING

### Setup
- Stripe account: Sandbox/test mode
- Product: "Connected Carriers"
- Monthly price: $99/month (price ID in STRIPE_PRICE_MONTHLY env var)
- Annual price: $999/year (price ID in STRIPE_PRICE_ANNUAL env var)
- Trial: 30 days, card collected at checkout
- Customer Portal: enabled for cancel/update

### Billing flow
1. Pricing page → "Start Free Trial" → POST /api/billing/checkout-session → Stripe Checkout
2. Stripe Checkout (30-day trial, card collected) → success redirect to /billing
3. Webhooks (POST /api/webhooks/stripe) update broker_billing table
4. /billing page shows plan status, trial countdown, "Manage Billing" button
5. "Manage Billing" → Stripe Customer Portal (hosted by Stripe)

### Webhook events handled
- checkout.session.completed
- customer.subscription.created / updated / deleted
- invoice.paid / invoice.payment_failed

### Pilot users
- PILOT_EMAILS env var (comma-separated emails)
- Auto-provisioned as "active" with "Pilot Partner" badge
- No Stripe customer created — full access, no billing

### Soft usage gates (public pages)
- Dispatch verification: 3 free arrival checks (localStorage counter)
- Post a Load: 1 free load creation (localStorage counter)
- After limit: form replaced with trial signup prompt → pricing page

---

## 6. PRODUCT ARCHITECTURE — THE FULL PIPELINE

### Three-layer product framing (decided)
1. **Filter** — "Enter the MC. Get the answer." (FMCSA check, instant qualification)
2. **Chase** — "The system chases. You don't." (10-min nudge cadence, 2 max, then alert broker)
3. **Signal** — "Know if something changed at pickup." (geofence gate, GPS, timing, broker alert)

### Full pipeline flow
```
Kate creates load (post-load page or dashboard /loads Quick Create)
    → System generates slug + shareable link + board URL
    → Kate pastes link into DAT/Truckstop posting

Carrier clicks link (load apply page /load/:slug)
    → Enters MC number → instant FMCSA check
    → Qualified → submits interest (name, phone, email)
    → Kate gets SMS notification (when Twilio live)

Kate opens board (/board/:slug)
    → Sees qualified applicants with FMCSA status, profile completeness
    → Enters/confirms driver phone → clicks "Assign"

System checks carrier profile completeness:
    IF profile complete (CDL, VIN, insurance on file):
        → Skips doc chase → sends arrival check directly to driver
        → Kate gets: "Profile complete — arrival check sent. No docs to chase."
    IF profile incomplete:
        → Sends doc request SMS to carrier with profile link
        → Auto-chase: nudge at T+10min, nudge at T+20min
        → If no response after 2 nudges: Kate gets "carrier unresponsive" alert
        → Kate can reassign to another carrier (supersede)

Driver arrives at pickup → taps confirmation link:
    Green (within 1 mi): Kate gets "Confirmed ✓ — ON SITE"
    Yellow (1-2 mi): Kate gets "Nearby — NEAR — review before loading"
    Red (2+ mi): Driver bounced — "Not at pickup yet. Tap again when you arrive."
    No GPS: Driver bounced — "Location required. Allow location and try again."

Supersede (if Kate reassigns):
    → Old verification marked superseded
    → Old driver gets: "Load reassigned. Complete your profile for faster clearance."
    → Old driver's verify link shows reassignment page with profile CTA
    → Builds the carrier profile flywheel
```

### "What needs attention?" summary
The `/loads` page in the broker dashboard shows a prioritized action card:
- 🔴 Red signal — something changed at pickup (call carrier)
- 🟡 Yellow signal — review before loading
- ⚠️ No arrival confirmation after 2 reminders (call/reassign)
- 👤 Carriers interested — ready to assign
- ⏳ Waiting on arrival — reminder sent
- 📭 No applicants — consider reposting
- ✅ Green signal — all clear

---

## 7. KATE GONZALEZ — PILOT USER

- Company: Logistics Xpress
- MC#: 064447
- Email: kate@logisticsxpress.com
- Dashboard login: kateloads@logisticsxpress.com (seeded account)
- PILOT_EMAILS: kate@logisticsxpress.com → full access, no billing
- Policy: $1M auto / $100K cargo / $1M GL / 180-day authority age / COI required

### Kate's feedback (April 13)
- "SHIPPER is supposed to confirm everything matches. SUPPOSED to. One of Joe's tire loads was stolen because the shipper did not confirm the VIN number."
- Changes happen 5% of the time, more with spot loads
- Biggest headache: "Communicating with dispatch to get required docs/photos"
- Follows up within 10 minutes, chases twice, then moves on
- Carriers go quiet, not brokers: "We ask them to confirm by sending docs and THEY go quiet"

---

## 8. SECURITY STATUS

| Item | Status |
|------|--------|
| Default credentials | ✅ Fixed — seed.ts uses SEED_PASSWORD or crypto random |
| SESSION_SECRET | ✅ Fixed — exits on boot if not set in production |
| Stored XSS | ✅ Fixed — h() escapeHtml on all user fields |
| CSRF protection | ✅ Fixed — session double-submit token on broker POSTs |
| Pickup code generation | ✅ Fixed — crypto.randomInt() |
| Stripe webhook verification | ✅ STRIPE_WEBHOOK_SECRET verifies signatures |
| Custom domain | ✅ Cloudflare + Railway — HTTPS on all domains |
| Session cookies | ✅ Secure + httpOnly + trust proxy |
| GitHub token in docs | ✅ Scrubbed |
| Rate limiting (load apply) | ✅ Max 10 MC checks per hour per MC number |
| Rate limiting (carrier profile) | ✅ Basic rate limiting on uploads |
| Full security review | ❌ Deferred — needs dedicated block |

---

## 9. PAGES BUILT TODAY (April 13)

1. **Homepage rewrite** — three-layer messaging, Joe's tires scenario, dual CTAs
2. **Homepage copy polish** — 5 targeted tweaks (MC language, pickup framing, fewer calls line)
3. **Post a Load page** — broker creates loads, gets shareable link + post text
4. **Load Apply page** — carrier enters MC, instant FMCSA qualification, interest submission
5. **Broker Load Board** — qualified applicants with one-click assign + driver phone input
6. **Assign pipeline** — auto-sends doc request or arrival check based on profile completeness
7. **Pricing page** — $99/mo, $999/yr, monthly/annual toggle, 30-day trial
8. **Stripe integration** — checkout, webhooks, billing page, customer portal
9. **Pilot user system** — free access for Kate via PILOT_EMAILS
10. **My Loads dashboard page** — load management + Quick Create + attention summary
11. **"What needs attention?"** — prioritized action items across all loads
12. **Soft usage gates** — 3 free arrival checks, 1 free load, then trial prompt
13. **Tooltips** — contextual help on dispatch and post-load form fields
14. **About/Privacy/Terms/Contact updates** — three-layer alignment, billing terms, WA governing law
15. **Dispatch page copy tightening** — 8 surgical fixes per product spec
16. **DNS migration** — GoDaddy → Cloudflare, Railway custom domains verified
17. **Cross-page navigation** — all pages linked, no islands
18. **Workflow diagram PDF** — one-page swim lane for Kate

---

## 10. BLOCKED / PENDING

| Item | Blocker | Impact |
|------|---------|--------|
| SMS delivery | Twilio A2P approval (5-7 days) | All SMS wired but can't send |
| End-to-end test | Twilio | Can't test arrival check with real phones |
| Kate pilot | Twilio + email to Kate | She has the site link, needs to try it |
| Google Workspace | Trial ends April 20 | Decision needed |
| honexai.com | Domain parked at GoDaddy | Links removed, needs landing page |
| Stripe live mode | Need to switch from sandbox | Not urgent until real customers |

---

## 11. PRODUCT ROADMAP

```
Layer 1 (BUILT):  Filter — load apply page, MC check, inbound carrier qualification
Layer 1B (BUILT): Chase — auto doc request, 10-min nudge, broker alerts
Layer 1C (BUILT): Signal — arrival check, geofence gate, GPS, timing flags
Layer 1D (BUILT): Pipeline — assign, profile check, auto-route to docs or arrival check
Layer 1E (BUILT): Billing — Stripe, pricing page, trial, pilot users
Layer 2 (NEXT):   Kate pilot — real loads, real SMS, real feedback
Layer 3:          Dispatch Readiness board (prototyped, deploy after validation)
Layer 4:          Setup packet auto-chase SMS
Layer 5:          Pickup code as dock-side authorization (V2 — needs shipper)
Layer 6:          Performance memory per carrier per load
Layer 7:          Network intelligence across multiple brokers
Layer 8:          Load marketplace for pre-screened carriers
```

---

## 12. KEY LESSONS / GOTCHAS

- GoDaddy does NOT support root-level CNAMEs — must use Cloudflare for Railway custom domains
- Railway "One-click DNS Setup" with Cloudflare works but may need delete + re-add if CNAME target changes
- Stripe SDK v22 changed type exports — use `any` instead of `Stripe.Event` etc. to avoid TS errors
- Stripe webhook endpoint needs raw body — register `express.raw()` BEFORE `express.json()` in Express
- The `www` subdomain needs its own custom domain entry in Railway (separate from root)
- All inter-page links use absolute URLs to `connectedcarriers.org` — no relative paths
- MCP server API URLs (`cc-mcp-server-production.up.railway.app`) are different from the landing page domain
- `honexai.com` points to GoDaddy parking page — links removed, plain text only until landing page built
- Board page lives on MCP server domain — context switch from app.connectedcarriers.org; acceptable for now
- Soft gates use localStorage — not bulletproof, intentionally so
