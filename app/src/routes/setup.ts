import { Router, Request, Response } from "express";
import crypto from "crypto";
import multer from "multer";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { h, csrfToken } from "../middleware/security";
import { layout } from "../views/layout";
import { uploadToR2, deleteFromR2, getPresignedDownloadUrl, validateUpload, isR2Configured } from "../lib/storage";

const router = Router();

// multer: memory storage — buffer goes straight to R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const DOC_TYPES = ["coi", "w9", "signed_agreement"] as const;
type DocType = typeof DOC_TYPES[number];

const DOC_LABELS: Record<DocType, string> = {
  coi: "Certificate of Insurance",
  w9: "W-9",
  signed_agreement: "Signed Carrier Agreement",
};

// ── BROKER: Create setup packet ───────────────────────────────────

router.post("/carriers/:id/setup/create", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const userId = req.session.userId!;
  const carrierId = parseInt(req.params.id);

  try {
    const carrierRes = await query(
      `SELECT * FROM carriers WHERE id=$1 AND broker_account_id=$2 AND onboarding_status NOT IN ('rejected')`,
      [carrierId, accountId]
    );
    if (!carrierRes.rows.length) return res.redirect(`/carriers/${carrierId}?error=not_eligible`);

    const carrier = carrierRes.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await query(`
      INSERT INTO carrier_setup_packets
        (broker_account_id, carrier_id, token, expires_at, created_by,
         carrier_name, carrier_email, carrier_phone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [
      accountId, carrierId, token, expiresAt, userId,
      carrier.legal_name || carrier.company_name || null,
      carrier.email || null,
      carrier.phone || null,
    ]);

    const packetId = result.rows[0].id;

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('carrier_setup_packet', $1, 'broker_user', $2, 'setup_packet_created', $3)
    `, [packetId, userId, JSON.stringify({ carrier_id: carrierId, token: token.slice(0, 8) + "..." })]);

    res.redirect(`/carriers/${carrierId}?setup_created=1`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}?error=setup_create_failed`);
  }
});

// ── BROKER: Setup packet review screen ───────────────────────────

router.get("/carriers/:id/setup/:packetId", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const carrierId = parseInt(req.params.id);
  const packetId = parseInt(req.params.packetId);

  try {
    const packetRes = await query(`
      SELECT csp.*, c.legal_name, c.company_name, c.mc_number,
             bu.name as created_by_name
      FROM carrier_setup_packets csp
      JOIN carriers c ON c.id = csp.carrier_id
      LEFT JOIN broker_users bu ON bu.id = csp.created_by
      WHERE csp.id=$1 AND csp.broker_account_id=$2 AND csp.carrier_id=$3
    `, [packetId, accountId, carrierId]);

    if (!packetRes.rows.length) return res.status(404).send("Setup packet not found");

    const packet = packetRes.rows[0];

    const docsRes = await query(`
      SELECT cd.*, bu.name as verified_by_name
      FROM carrier_documents cd
      LEFT JOIN broker_users bu ON bu.id = cd.verified_by
      WHERE cd.carrier_setup_packet_id=$1
      ORDER BY cd.created_at ASC
    `, [packetId]);

    const activityRes = await query(`
      SELECT * FROM activity_logs
      WHERE subject_type='carrier_setup_packet' AND subject_id=$1
      ORDER BY created_at DESC LIMIT 30
    `, [packetId]);

    const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";
    const setupUrl = `${BASE_URL}/setup/${packet.token}`;
    const csrf = csrfToken(req);

    const html = layout({
      title: `Setup Packet — ${packet.legal_name || packet.company_name || "Carrier"}`,
      userName: req.session.userName || "",
      userRole: req.session.userRole,
      csrfToken: csrf,
      content: brokerSetupContent(packet, docsRes.rows, activityRes.rows, setupUrl, csrf, req.query),
    });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading setup packet");
  }
});

// ── BROKER: Download a doc via presigned URL ──────────────────────

router.get("/carriers/:id/setup/:packetId/doc/:docId/download", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const docId = parseInt(req.params.docId);

  try {
    const docRes = await query(`
      SELECT cd.* FROM carrier_documents cd
      JOIN carrier_setup_packets csp ON csp.id = cd.carrier_setup_packet_id
      WHERE cd.id=$1 AND csp.broker_account_id=$2
    `, [docId, accountId]);

    if (!docRes.rows.length) return res.status(404).send("Document not found");
    const doc = docRes.rows[0];

    if (doc.r2_object_key) {
      const url = await getPresignedDownloadUrl(doc.r2_object_key, 300);
      return res.redirect(url);
    }
    if (doc.file_url && !doc.file_url.startsWith("r2://")) {
      return res.redirect(doc.file_url);
    }
    res.status(404).send("File not available");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating download link");
  }
});

// ── BROKER: Verify / reject a document ───────────────────────────

router.post("/carriers/:id/setup/:packetId/doc/:docId/verify", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const userId = req.session.userId!;
  const { action, notes } = req.body;
  const docId = parseInt(req.params.docId);
  const packetId = parseInt(req.params.packetId);
  const carrierId = parseInt(req.params.id);

  if (!["verified", "rejected"].includes(action)) {
    return res.redirect(`/carriers/${carrierId}/setup/${packetId}?error=invalid_action`);
  }

  try {
    if (action === "verified") {
      await query(
        `UPDATE carrier_documents SET verification_status=$1, verified_at=NOW(), verified_by=$2, last_reviewed_at=NOW(), notes=COALESCE($3,notes), updated_at=NOW() WHERE id=$4`,
        [action, userId, notes?.trim() || null, docId]
      );
    } else {
      await query(
        `UPDATE carrier_documents SET verification_status=$1, verified_at=NULL, verified_by=NULL, last_reviewed_at=NOW(), notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3`,
        [action, notes?.trim() || null, docId]
      );
    }

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('carrier_setup_packet', $1, 'broker_user', $2, $3, $4)
    `, [packetId, userId, `doc_${action}`, JSON.stringify({ doc_id: docId, notes })]);

    // Check if all required docs are verified → auto-complete
    await maybeCompletePacket(packetId, accountId, userId);

    res.redirect(`/carriers/${carrierId}/setup/${packetId}?saved=1`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}/setup/${packetId}?error=verify_failed`);
  }
});

// ── BROKER: Mark setup complete manually ─────────────────────────

router.post("/carriers/:id/setup/:packetId/complete", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const userId = req.session.userId!;
  const packetId = parseInt(req.params.packetId);
  const carrierId = parseInt(req.params.id);
  const { override_reason } = req.body;

  // Require an explicit reason for manual override
  if (!override_reason?.trim()) {
    return res.redirect(`/carriers/${carrierId}/setup/${packetId}?error=override_reason_required`);
  }

  try {
    await query(`UPDATE carrier_setup_packets SET broker_status='complete', updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [packetId, accountId]);
    await query(`UPDATE carriers SET onboarding_status='approved', updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [carrierId, accountId]);
    await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata) VALUES ('carrier_setup_packet', $1, 'broker_user', $2, 'setup_override_approved', $3)`,
      [packetId, userId, JSON.stringify({ manual_override: true, reason: override_reason.trim() })]);

    res.redirect(`/carriers/${carrierId}?setup_complete=1`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}/setup/${packetId}?error=complete_failed`);
  }
});

// ── BROKER: Cancel setup packet ───────────────────────────────────

router.post("/carriers/:id/setup/:packetId/cancel", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const packetId = parseInt(req.params.packetId);
  const carrierId = parseInt(req.params.id);

  await query(`UPDATE carrier_setup_packets SET broker_status='cancelled', updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [packetId, accountId]);
  res.redirect(`/carriers/${carrierId}`);
});

// ── PUBLIC: Carrier setup checklist (resumable) ───────────────────

router.get("/setup/:token", async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const packetRes = await query(`
      SELECT csp.*, ba.company_name as broker_company, c.mc_number
      FROM carrier_setup_packets csp
      JOIN broker_accounts ba ON ba.id = csp.broker_account_id
      LEFT JOIN carriers c ON c.id = csp.carrier_id
      WHERE csp.token=$1
    `, [token]);

    if (!packetRes.rows.length) return res.send(setupErrorPage("This link is invalid or has expired."));
    const packet = packetRes.rows[0];

    if (["cancelled", "rejected"].includes(packet.broker_status)) return res.send(setupErrorPage("This setup link has been cancelled. Contact your broker."));
    if (packet.broker_status === "expired" || new Date(packet.expires_at) < new Date()) {
      await query(`UPDATE carrier_setup_packets SET broker_status='expired' WHERE id=$1`, [packet.id]);
      return res.send(setupErrorPage("This setup link has expired. Ask your broker for a new one."));
    }

    const docsRes = await query(`
      SELECT * FROM carrier_documents WHERE carrier_setup_packet_id=$1
    `, [packet.id]);

    const docs = docsRes.rows;

    res.send(setupChecklistPage(token, packet, docs, req.query.saved as string, req.query.error as string));
  } catch (err) {
    console.error(err);
    res.status(500).send(setupErrorPage("Something went wrong. Please try again."));
  }
});

// ── PUBLIC: Submit company info ───────────────────────────────────

router.post("/setup/:token/company", async (req: Request, res: Response) => {
  const { token } = req.params;
  const { carrier_name, carrier_email, carrier_phone } = req.body;

  try {
    const packetRes = await query(`SELECT * FROM carrier_setup_packets WHERE token=$1 AND broker_status IN ('under_review')`, [token]);
    if (!packetRes.rows.length) return res.send(setupErrorPage("This link is invalid or expired."));

    const pkt = packetRes.rows[0];
    await query(`UPDATE carrier_setup_packets SET carrier_name=$1, carrier_email=$2, carrier_phone=$3, updated_at=NOW() WHERE token=$4`,
      [carrier_name?.trim() || null, carrier_email?.trim() || null, carrier_phone?.trim() || null, token]);

    await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata) VALUES ('carrier_setup_packet', $1, 'carrier', NULL, 'carrier_company_info_saved', $2)`,
      [pkt.id, JSON.stringify({ carrier_name: carrier_name?.trim() || null })]);

    await updatePacketCarrierStatus(pkt.id);
    res.redirect(`/setup/${token}?saved=company`);
  } catch (err) {
    console.error(err);
    res.redirect(`/setup/${token}?error=save_failed`);
  }
});

// ── PUBLIC: Upload a document (file or URL) ───────────────────────

router.post("/setup/:token/doc/:type", upload.single("file"), async (req: Request, res: Response) => {
  const { token, type } = req.params;

  if (!DOC_TYPES.includes(type as DocType)) {
    return res.redirect(`/setup/${token}?error=invalid_doc_type`);
  }

  try {
    const packetRes = await query(`
      SELECT csp.*, bp.broker_account_id
      FROM carrier_setup_packets csp
      LEFT JOIN broker_policies bp ON bp.broker_account_id = csp.broker_account_id
      WHERE csp.token=$1 AND csp.broker_status='under_review' AND csp.expires_at > NOW()
    `, [token]);

    if (!packetRes.rows.length) return res.send(setupErrorPage("This link is invalid or expired."));
    const packet = packetRes.rows[0];

    const { expires_at_doc, insurer_name, link_url } = req.body;

    let fileUrl: string | null = null;
    let r2ObjectKey: string | null = null;
    let fileName: string | null = null;
    let fileSize: number | null = null;
    let mimeType: string | null = null;

    // File upload path (primary)
    if (req.file) {
      const validationError = validateUpload(req.file.mimetype, req.file.size);
      if (validationError) return res.redirect(`/setup/${token}?error=${encodeURIComponent(validationError)}`);

      if (!isR2Configured()) {
        return res.redirect(`/setup/${token}?error=storage_not_configured`);
      }

      const uploaded = await uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype, `setup/${packet.id}`);
      r2ObjectKey = uploaded.objectKey;
      fileUrl = uploaded.fileUrl;
      fileName = uploaded.fileName;
      fileSize = uploaded.fileSize;
      mimeType = uploaded.mimeType;
    }
    // URL fallback path
    else if (link_url?.trim()) {
      fileUrl = link_url.trim();
      fileName = link_url.trim();
    } else {
      return res.redirect(`/setup/${token}?error=no_file_provided`);
    }

    // Upsert document — one row per doc type per packet
    const existing = await query(`SELECT id, r2_object_key FROM carrier_documents WHERE carrier_setup_packet_id=$1 AND document_type=$2`, [packet.id, type]);

    if (existing.rows.length) {
      // Delete old R2 object if this is a file replacement
      const oldKey = existing.rows[0].r2_object_key;
      if (oldKey && r2ObjectKey && oldKey !== r2ObjectKey) {
        try {
          await deleteFromR2(oldKey);
        } catch (cleanupErr) {
          console.error("R2 cleanup failed for old object:", oldKey, cleanupErr);
          // Non-blocking — log and continue
        }
      }

      await query(`
        UPDATE carrier_documents SET
          file_url=$1, r2_object_key=$2, file_name=$3, file_size=$4, mime_type=$5,
          expires_at=$6, insurer_name=$7,
          verification_status='pending', verified_at=NULL, verified_by=NULL,
          updated_at=NOW()
        WHERE id=$8
      `, [fileUrl, r2ObjectKey, fileName, fileSize, mimeType,
          expires_at_doc || null, insurer_name?.trim() || null,
          existing.rows[0].id]);
    } else {
      await query(`
        INSERT INTO carrier_documents
          (carrier_id, carrier_setup_packet_id, document_type, file_url, r2_object_key,
           file_name, file_size, mime_type, expires_at, insurer_name, verification_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
      `, [packet.carrier_id, packet.id, type, fileUrl, r2ObjectKey,
          fileName, fileSize, mimeType, expires_at_doc || null, insurer_name?.trim() || null]);
    }

    await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata) VALUES ('carrier_setup_packet', $1, 'carrier', NULL, 'carrier_document_uploaded', $2)`,
      [packet.id, JSON.stringify({ document_type: type, file_name: fileName, replaced: existing.rows.length > 0 })]);

    await updatePacketCarrierStatus(packet.id);
    res.redirect(`/setup/${token}?saved=${type}`);
  } catch (err) {
    console.error("Setup doc upload error:", err);
    res.redirect(`/setup/${token}?error=upload_failed`);
  }
});

export default router;

// ── Helpers ───────────────────────────────────────────────────────

async function updatePacketCarrierStatus(packetId: number) {
  const docsRes = await query(`SELECT document_type FROM carrier_documents WHERE carrier_setup_packet_id=$1`, [packetId]);
  const submitted = new Set(docsRes.rows.map((r: Record<string,unknown>) => r.document_type));
  const allRequired = DOC_TYPES.every(t => submitted.has(t));
  const anySubmitted = submitted.size > 0;

  const newStatus = allRequired ? "submitted" : anySubmitted ? "partially_complete" : "pending";
  await query(`UPDATE carrier_setup_packets SET carrier_status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, packetId]);
}

async function maybeCompletePacket(packetId: number, accountId: number, userId: number) {
  const docsRes = await query(`
    SELECT document_type, verification_status FROM carrier_documents WHERE carrier_setup_packet_id=$1
  `, [packetId]);

  const docs = docsRes.rows;
  const allVerified = DOC_TYPES.every(t =>
    docs.some((d: Record<string,unknown>) => d.document_type === t && d.verification_status === "verified")
  );

  if (allVerified) {
    await query(`UPDATE carrier_setup_packets SET broker_status='complete', updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [packetId, accountId]);
    const packetRes = await query(`SELECT carrier_id FROM carrier_setup_packets WHERE id=$1`, [packetId]);
    if (packetRes.rows.length) {
      await query(`UPDATE carriers SET onboarding_status='approved', updated_at=NOW() WHERE id=$1`, [packetRes.rows[0].carrier_id]);
    }
    await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata) VALUES ('carrier_setup_packet', $1, 'broker_user', $2, 'setup_auto_complete', $3)`,
      [packetId, userId, JSON.stringify({ auto: true })]);
  }
}

// ── Public page: carrier checklist ───────────────────────────────

function setupChecklistPage(
  token: string,
  packet: Record<string,unknown>,
  docs: Record<string,unknown>[],
  saved?: string,
  error?: string
): string {
  const brokerName = String(packet.broker_company || "your broker");
  const isExpired = new Date(String(packet.expires_at)) < new Date();
  const isSubmitted = packet.carrier_status === "submitted";

  const docMap: Record<string, Record<string,unknown>> = {};
  for (const doc of docs) docMap[String(doc.document_type)] = doc;

  const hasAll = DOC_TYPES.every(t => docMap[t]);
  const hasCompanyInfo = !!(packet.carrier_name && packet.carrier_email && packet.carrier_phone);

  const savedMessages: Record<string, string> = {
    company: "Company info saved.",
    coi: "Certificate of Insurance uploaded.",
    w9: "W-9 uploaded.",
    signed_agreement: "Carrier agreement uploaded.",
  };

  const docStatusIcon = (type: DocType) => {
    const doc = docMap[type];
    if (!doc) return `<span style="color:#6b7a8a;font-size:18px">○</span>`;
    if (doc.verification_status === "verified") return `<span style="color:#10b981;font-size:18px">✓</span>`;
    if (doc.verification_status === "rejected") return `<span style="color:#ef4444;font-size:18px">✗</span>`;
    return `<span style="color:#C8892A;font-size:18px">●</span>`;
  };

  const docStatus = (type: DocType) => {
    const doc = docMap[type];
    if (!doc) return `<span style="color:#6b7a8a;font-size:12px">Not submitted</span>`;
    if (doc.verification_status === "verified") return `<span style="color:#10b981;font-size:12px">Verified ✓</span>`;
    if (doc.verification_status === "rejected") return `<span style="color:#ef4444;font-size:12px">Rejected — please resubmit</span>`;
    return `<span style="color:#C8892A;font-size:12px">Submitted — awaiting review</span>`;
  };

  const companyComplete = hasCompanyInfo;
  const doneCount = (companyComplete ? 1 : 0) + DOC_TYPES.filter(t => docMap[t] && docMap[t].verification_status !== "rejected").length;
  const totalCount = 1 + DOC_TYPES.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Carrier Setup — ${h(brokerName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate: #1C2B3A; --amber: #C8892A; --amber2: #E09B35;
    --cream: #F7F5F0; --cream2: #EDE9E1; --cream3: #E0DAD0;
    --ink: #141414; --muted: #6B7A8A;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  body { font-family: var(--sans); background: var(--cream); color: var(--ink); font-size: 15px; }
  nav { background: var(--slate); height: 56px; display: flex; align-items: center; padding: 0 24px; }
  .nav-logo { font-family: var(--serif); font-size: 17px; color: var(--cream); text-decoration: none; }
  .nav-logo span { color: var(--amber); }
  .page { max-width: 540px; margin: 0 auto; padding: 28px 20px 64px; }
  .header { margin-bottom: 24px; }
  .eyebrow { font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--amber); margin-bottom: 8px; }
  .title { font-family: var(--serif); font-size: 24px; font-weight: 400; color: var(--slate); margin-bottom: 6px; }
  .sub { font-size: 13px; color: var(--muted); line-height: 1.6; }
  .progress { background: var(--cream3); border-radius: 99px; height: 6px; margin: 20px 0; }
  .progress-fill { background: var(--amber); border-radius: 99px; height: 6px; transition: width 0.3s; }
  .progress-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .checklist-item { background: white; border: 1px solid var(--cream3); border-radius: 3px; margin-bottom: 10px; overflow: hidden; }
  .checklist-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; user-select: none; }
  .checklist-header:hover { background: #fafaf8; }
  .checklist-label { flex: 1; }
  .checklist-name { font-size: 14px; font-weight: 500; color: var(--slate); }
  .checklist-body { padding: 0 16px 16px; border-top: 1px solid var(--cream2); }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 11px; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
  .field input, .field select { width: 100%; padding: 10px 12px; border: 1px solid var(--cream3); border-radius: 2px; font-family: var(--sans); font-size: 14px; color: var(--ink); background: white; outline: none; -webkit-appearance: none; }
  .field input:focus, .field select:focus { border-color: var(--amber); }
  .field .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .file-area { border: 2px dashed var(--cream3); border-radius: 3px; padding: 20px; text-align: center; cursor: pointer; transition: border-color 0.15s; }
  .file-area:hover, .file-area.drag-over { border-color: var(--amber); }
  .file-area input { display: none; }
  .file-area-label { font-size: 13px; color: var(--muted); }
  .file-area-label strong { color: var(--amber); }
  .divider { text-align: center; font-size: 11px; color: var(--muted); margin: 12px 0; }
  .submit-btn { width: 100%; padding: 12px; background: var(--amber); color: var(--slate); border: none; border-radius: 2px; font-family: var(--sans); font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 4px; }
  .submit-btn:hover { background: var(--amber2); }
  .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .alert-success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; padding: 10px 14px; border-radius: 2px; font-size: 13px; margin-bottom: 16px; }
  .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 10px 14px; border-radius: 2px; font-size: 13px; margin-bottom: 16px; }
  .complete-banner { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 3px; padding: 20px; text-align: center; }
  .complete-icon { font-size: 36px; margin-bottom: 10px; }
  .powered { text-align: center; font-size: 11px; color: var(--muted); margin-top: 24px; }
</style>
</head>
<body>
<nav><a href="https://connectedcarriers.org" class="nav-logo">Connected<span>Carriers</span></a></nav>
<div class="page">
  <div class="header">
    <div class="eyebrow">Carrier Setup</div>
    <h1 class="title">Compliance packet for ${h(brokerName)}</h1>
    <p class="sub">Submit your compliance documents to get cleared for loads. You can save progress and return to this link anytime.</p>
  </div>

  ${saved && savedMessages[saved] ? `<div class="alert-success">✓ ${savedMessages[saved]}</div>` : ""}
  ${error ? `<div class="alert-error">⚠ ${h(decodeURIComponent(error))}</div>` : ""}

  ${isSubmitted ? `
  <div class="complete-banner">
    <div class="complete-icon">✓</div>
    <div style="font-family:var(--serif);font-size:18px;color:var(--slate);margin-bottom:6px">All documents submitted</div>
    <p style="font-size:13px;color:var(--muted)">${h(brokerName)} is reviewing your documents. You'll hear from them directly.</p>
  </div>
  ` : `
  <div class="progress-label">${doneCount} of ${totalCount} items complete</div>
  <div class="progress"><div class="progress-fill" style="width:${Math.round((doneCount/totalCount)*100)}%"></div></div>

  <!-- Company Info -->
  <div class="checklist-item">
    <div class="checklist-header" onclick="toggle('company')">
      <span>${companyComplete ? `<span style="color:#10b981;font-size:18px">✓</span>` : `<span style="color:#6b7a8a;font-size:18px">○</span>`}</span>
      <div class="checklist-label">
        <div class="checklist-name">Company information</div>
        ${companyComplete ? `<div style="font-size:12px;color:#10b981">Complete</div>` : `<div style="font-size:12px;color:#6b7a8a">Required</div>`}
      </div>
      <span style="color:var(--muted);font-size:12px" id="company-toggle">▼</span>
    </div>
    <div id="company-body" class="checklist-body" style="${companyComplete ? "display:none" : ""}">
      <form method="POST" action="/setup/${token}/company" style="margin-top:14px">
        <div class="field">
          <label>Legal company name</label>
          <input type="text" name="carrier_name" value="${h(packet.carrier_name || "")}" placeholder="e.g. Swift Eagle Transport LLC">
        </div>
        <div class="field">
          <label>Contact email</label>
          <input type="email" name="carrier_email" value="${h(packet.carrier_email || "")}" placeholder="dispatch@yourcompany.com" inputmode="email">
        </div>
        <div class="field">
          <label>Contact phone</label>
          <input type="tel" name="carrier_phone" value="${h(packet.carrier_phone || "")}" placeholder="e.g. 602-555-0100" inputmode="tel">
        </div>
        <button type="submit" class="submit-btn">Save company info</button>
      </form>
    </div>
  </div>

  ${DOC_TYPES.map(type => {
    const doc = docMap[type];
    const isComplete = doc && doc.verification_status !== "rejected";
    const isRejected = doc && doc.verification_status === "rejected";
    return `
  <div class="checklist-item">
    <div class="checklist-header" onclick="toggle('${type}')">
      ${docStatusIcon(type)}
      <div class="checklist-label">
        <div class="checklist-name">${DOC_LABELS[type]}</div>
        ${docStatus(type)}
      </div>
      <span style="color:var(--muted);font-size:12px" id="${type}-toggle">▼</span>
    </div>
    <div id="${type}-body" class="checklist-body" style="${isComplete && !isRejected ? "display:none" : ""}">
      <form method="POST" action="/setup/${token}/doc/${type}" enctype="multipart/form-data" style="margin-top:14px" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Uploading…'">
        ${type === "coi" ? `
        <div class="field">
          <label>Insurer name</label>
          <input type="text" name="insurer_name" value="${h(String(doc?.insurer_name || ""))}" placeholder="e.g. Progressive Commercial">
        </div>
        <div class="field">
          <label>Coverage expiration date</label>
          <input type="date" name="expires_at_doc" value="${doc?.expires_at ? String(doc.expires_at).split("T")[0] : ""}">
        </div>
        ` : ""}
        <div class="field">
          <label>Upload file</label>
          <div class="file-area" onclick="document.getElementById('file-${type}').click()">
            <input type="file" id="file-${type}" name="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"
              onchange="document.getElementById('file-label-${type}').textContent = this.files[0]?.name || 'Choose file'">
            <div class="file-area-label" id="file-label-${type}">
              <strong>Tap to upload</strong> or drag a file here<br>
              <span style="font-size:11px">PDF, JPG, PNG, Word — max 10MB</span>
            </div>
          </div>
        </div>
        <div class="divider">— or paste a link —</div>
        <div class="field">
          <label>Document URL <span style="font-weight:400;font-size:10px">(Google Drive, Dropbox, etc.)</span></label>
          <input type="url" name="link_url" placeholder="https://…" inputmode="url">
          <div class="hint">Make sure the link is set to "Anyone with the link can view"</div>
        </div>
        <button type="submit" class="submit-btn">${doc ? "Replace document" : "Submit document"}</button>
      </form>
    </div>
  </div>`;
  }).join("")}
  `}

  <div class="powered">Powered by Connected Carriers · A HoneXAI product</div>
</div>
<script>
function toggle(id) {
  const body = document.getElementById(id + '-body');
  const tog = document.getElementById(id + '-toggle');
  if (body.style.display === 'none') { body.style.display = 'block'; tog.textContent = '▲'; }
  else { body.style.display = 'none'; tog.textContent = '▼'; }
}
// Drag-drop on file areas
document.querySelectorAll('.file-area').forEach(area => {
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', e => {
    e.preventDefault(); area.classList.remove('drag-over');
    const input = area.querySelector('input[type=file]');
    if (input && e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      area.querySelector('.file-area-label').textContent = e.dataTransfer.files[0].name;
    }
  });
});
</script>
</body>
</html>`;
}

// ── Broker review screen ──────────────────────────────────────────

function brokerSetupContent(
  packet: Record<string,unknown>,
  docs: Record<string,unknown>[],
  activity: Record<string,unknown>[],
  setupUrl: string,
  csrf: string,
  qs: Record<string,unknown>
): string {
  const carrierName = String(packet.legal_name || packet.company_name || "Carrier");
  const ts = (v: unknown) => v ? new Date(String(v)).toLocaleString() : "—";
  const td = (v: unknown) => v ? new Date(String(v)).toLocaleDateString() : "—";

  const docMap: Record<string, Record<string,unknown>> = {};
  for (const doc of docs) docMap[String(doc.document_type)] = doc;

  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const docRow = (type: DocType) => {
    const doc = docMap[type];
    const label = DOC_LABELS[type];

    if (!doc) return `
      <div class="card" style="opacity:0.6">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:500;font-size:13px">${label}</div>
            <div style="font-size:12px;color:var(--muted)">Not submitted yet</div>
          </div>
          <span class="badge" style="background:#6b7a8a20;color:#6b7a8a;border:1px solid #6b7a8a40">Pending</span>
        </div>
      </div>`;

    const vs = String(doc.verification_status || "pending");
    const statusColors: Record<string,string> = { pending: "#f59e0b", verified: "#10b981", rejected: "#ef4444", expired: "#6b7a8a" };
    const color = statusColors[vs] || "#6b7a8a";

    const expiresAt = doc.expires_at ? new Date(String(doc.expires_at)) : null;
    const isExpiringSoon = expiresAt && expiresAt > now && expiresAt < thirtyDays;
    const isExpired = expiresAt && expiresAt < now;

    return `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div>
            <div style="font-weight:500;font-size:13px">${label}</div>
            ${doc.insurer_name ? `<div style="font-size:12px;color:var(--muted)">${h(doc.insurer_name)}</div>` : ""}
            ${doc.file_name ? `<div style="font-size:11px;color:var(--muted)">${h(doc.file_name)}</div>` : ""}
          </div>
          <span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${vs}</span>
        </div>
        ${expiresAt ? `
          <div style="font-size:12px;margin-bottom:8px;color:${isExpired ? "#ef4444" : isExpiringSoon ? "#f59e0b" : "var(--muted)"}">
            ${isExpired ? "🔴" : isExpiringSoon ? "⚠" : "📅"} Expires: ${td(doc.expires_at)}
          </div>` : ""}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <a href="/carriers/${packet.carrier_id}/setup/${packet.id}/doc/${doc.id}/download"
             target="_blank" class="btn-sm">View document →</a>
        </div>
        <form method="POST" action="/carriers/${packet.carrier_id}/setup/${packet.id}/doc/${doc.id}/verify">
          <input type="hidden" name="_csrf" value="${h(csrf)}">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <button name="action" value="verified" class="btn-sm" style="background:#10b981;color:white">✓ Verify</button>
            <button name="action" value="rejected" class="btn-sm" style="background:#ef444420;color:#ef4444">✗ Reject</button>
          </div>
          <input type="text" name="notes" placeholder="Add note (optional)" style="width:100%;padding:7px 10px;border:1px solid var(--cream3);border-radius:2px;font-size:13px;font-family:var(--sans)">
        </form>
        ${doc.verified_by_name ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">Verified by ${h(doc.verified_by_name)} · ${ts(doc.verified_at)}</div>` : ""}
        ${doc.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;font-style:italic">${h(doc.notes)}</div>` : ""}
      </div>`;
  };

  const isComplete = packet.broker_status === "complete";
  const carrierStatusColors: Record<string,string> = { pending: "#6b7a8a", partially_complete: "#f59e0b", submitted: "#3b82f6" };
  const brokerStatusColors: Record<string,string> = { under_review: "#f59e0b", complete: "#10b981", rejected: "#ef4444", expired: "#6b7a8a", cancelled: "#6b7a8a" };

  return `
<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <a href="/carriers/${packet.carrier_id}" class="back-link">← ${h(carrierName)}</a>
    <h1 class="page-title">Compliance Setup Packet</h1>
    <div class="page-meta">
      <span class="badge" style="background:${carrierStatusColors[String(packet.carrier_status)]}20;color:${carrierStatusColors[String(packet.carrier_status)]};border:1px solid ${carrierStatusColors[String(packet.carrier_status)]}40">Carrier: ${h(packet.carrier_status)}</span>
      <span class="sep">·</span>
      <span class="badge" style="background:${brokerStatusColors[String(packet.broker_status)]}20;color:${brokerStatusColors[String(packet.broker_status)]};border:1px solid ${brokerStatusColors[String(packet.broker_status)]}40">Broker: ${h(packet.broker_status)}</span>
    </div>
  </div>
  ${!isComplete ? `
  <form method="POST" action="/carriers/${packet.carrier_id}/setup/${packet.id}/cancel">
    <input type="hidden" name="_csrf" value="${h(csrf)}">
    <button style="background:none;border:1px solid #ef4444;color:#ef4444;padding:6px 12px;border-radius:2px;cursor:pointer;font-size:12px">Cancel</button>
  </form>` : ""}
</div>

${qs.saved ? `<div class="alert alert-success">Document action saved.</div>` : ""}
${qs.error === "override_reason_required" ? `<div class="alert alert-error">A reason is required to override and approve manually.</div>` : qs.error ? `<div class="alert alert-error">Error: ${h(String(qs.error)).replace(/_/g," ")}.</div>` : ""}

<div class="detail-grid">
<div class="detail-left">

  <div class="card">
    <div class="card-title">Setup link</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Send this link to the carrier. It expires ${new Date(String(packet.expires_at)).toLocaleDateString()}.</div>
    <div style="display:flex;gap:8px;align-items:center">
      <code style="font-size:11px;background:var(--cream);padding:6px 8px;border-radius:2px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(setupUrl)}</code>
      <button onclick="navigator.clipboard.writeText('${h(setupUrl)}').then(()=>this.textContent='Copied!').catch(()=>{})" class="btn-sm">Copy</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Carrier info</div>
    <div class="info-grid">
      ${packet.mc_number ? `<div class="info-row"><span class="info-label">MC Number</span><span><code>MC${h(packet.mc_number)}</code></span></div>` : ""}
      <div class="info-row"><span class="info-label">Name</span><span>${h(packet.carrier_name || "—")}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span>${h(packet.carrier_email || "—")}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span>${h(packet.carrier_phone || "—")}</span></div>
      <div class="info-row"><span class="info-label">Created by</span><span>${h(packet.created_by_name || "—")}</span></div>
    </div>
  </div>

</div>
<div class="detail-right">

  <div class="card">
    <div class="card-title">Documents</div>
    ${DOC_TYPES.map(t => docRow(t)).join("")}
  </div>

  ${!isComplete ? `
  <div class="card" style="border-left:3px solid #f97316">
    <div class="card-title" style="color:#c2410c">Manual Override</div>
    <p style="font-size:12px;color:#9a3412;margin-bottom:12px;line-height:1.5">
      ⚠ Use only if you have verified compliance outside this system.<br>
      This bypasses document verification and immediately approves the carrier.
    </p>
    <form method="POST" action="/carriers/${packet.carrier_id}/setup/${packet.id}/complete">
      <input type="hidden" name="_csrf" value="${h(csrf)}">
      <div style="margin-bottom:8px">
        <label style="display:block;font-size:11px;font-weight:500;letter-spacing:0.07em;text-transform:uppercase;color:#9a3412;margin-bottom:4px">Reason for override <span style="color:#ef4444">*</span></label>
        <input type="text" name="override_reason" required placeholder="e.g. Verified docs via phone with insurer" style="width:100%;padding:8px 10px;border:1px solid #fed7aa;border-radius:2px;font-size:13px;font-family:var(--sans);background:white;color:var(--ink)">
      </div>
      <button type="submit" style="width:100%;padding:10px;background:#f97316;color:white;border:none;border-radius:2px;font-family:var(--sans);font-size:13px;cursor:pointer">Override &amp; Approve Carrier</button>
    </form>
  </div>` : `
  <div class="card" style="border-left:3px solid #10b981">
    <div class="card-title" style="color:#15803d">✓ Setup Complete</div>
    <p style="font-size:13px;color:var(--muted)">All compliance docs verified. Carrier is approved for dispatch.</p>
  </div>`}

  <div class="card">
    <div class="card-title">Activity</div>
    ${activity.length === 0 ? `<p class="muted" style="font-size:13px">No activity yet.</p>` : `
    <div class="activity-list">
      ${activity.map((a: Record<string,unknown>) => `
        <div class="activity-item">
          <div class="activity-action" style="font-size:13px">${h(setupActionLabel(String(a.action)))}</div>
          <div class="activity-time muted">${a.created_at ? new Date(String(a.created_at)).toLocaleString() : ""}</div>
        </div>`).join("")}
    </div>`}
  </div>

</div>
</div>`;
}

function setupActionLabel(action: string): string {
  const map: Record<string,string> = {
    setup_packet_created: "📋 Setup packet created",
    doc_verified:         "✓ Document verified",
    doc_rejected:         "✗ Document rejected",
    setup_complete:       "✓ Setup marked complete",
    setup_auto_complete:  "✓ Setup auto-completed (all docs verified)",
  };
  return map[action] || action;
}

function setupErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Unavailable</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#F7F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:white;border-radius:4px;border:1px solid #E0DAD0;padding:36px 32px;max-width:400px;width:100%;text-align:center}
h2{font-size:18px;color:#1C2B3A;margin-bottom:10px}p{font-size:14px;color:#6B7A8A;line-height:1.6}</style>
</head><body><div class="card"><h2>Link unavailable</h2><p>${h(message)}</p></div></body></html>`;
}
