import { Router, Response } from "express";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth, requireOwner } from "../middleware/auth";
import { h, csrfToken, csrfField } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

router.get("/settings", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;

  try {
    const accountRes = await query(`SELECT * FROM broker_accounts WHERE id = $1`, [accountId]);
    const policyRes = await query(`SELECT * FROM broker_policies WHERE broker_account_id = $1`, [accountId]);

    const account = accountRes.rows[0];
    const policy = policyRes.rows[0] || {};

    const csrf = csrfToken(req);
    const html = layout({
      title: "Settings",
      userName: req.session.userName || "",
      csrfToken: csrf,
      content: settingsContent(account, policy, req.query.saved as string, csrf),
    });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading settings");
  }
});

router.post("/settings", requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const b = req.body;

  const bool = (v: string) => v === "on" || v === "true" || v === "1";

  try {
    await query(`
      UPDATE broker_accounts SET
        company_name = $1, contact_name = $2, contact_email = $3, contact_phone = $4,
        updated_at = NOW()
      WHERE id = $5
    `, [b.company_name, b.contact_name, b.contact_email, b.contact_phone, accountId]);

    await query(`
      UPDATE broker_policies SET
        require_mc_active = $1, require_dot_active = $2, require_w9 = $3,
        require_signed_agreement = $4, minimum_authority_age_days = $5,
        minimum_insurance_auto = $6, minimum_insurance_cargo = $7,
        minimum_insurance_general = $8, certificate_holder_name = $9,
        require_additional_insured = $10, auto_reject_expired_coi = $11,
        coi_required_at_submission = $12, require_real_time_gps = $13,
        accept_owner_operators = $14, owner_operator_same_requirements = $15,
        double_brokering_flag_triggers_reject = $16,
        require_signed_rate_confirmation = $17, require_driver_phone = $18,
        require_truck_and_trailer_number = $19, require_dispatch_packet = $20,
        pickup_code_required = $21, updated_at = NOW()
      WHERE broker_account_id = $22
    `, [
      bool(b.require_mc_active), bool(b.require_dot_active), bool(b.require_w9),
      bool(b.require_signed_agreement), parseInt(b.minimum_authority_age_days) || 180,
      parseInt(b.minimum_insurance_auto) || 1000000,
      parseInt(b.minimum_insurance_cargo) || 100000,
      parseInt(b.minimum_insurance_general) || 1000000,
      b.certificate_holder_name,
      bool(b.require_additional_insured), bool(b.auto_reject_expired_coi),
      bool(b.coi_required_at_submission), bool(b.require_real_time_gps),
      bool(b.accept_owner_operators), bool(b.owner_operator_same_requirements),
      bool(b.double_brokering_flag_triggers_reject),
      bool(b.require_signed_rate_confirmation), bool(b.require_driver_phone),
      bool(b.require_truck_and_trailer_number), bool(b.require_dispatch_packet),
      bool(b.pickup_code_required),
      accountId
    ]);

    res.redirect("/settings?saved=1");
  } catch (err) {
    console.error(err);
    res.redirect("/settings?error=1");
  }
});

export default router;

function toggle(name: string, value: boolean, label: string): string {
  return `
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" name="${name}" ${value ? "checked" : ""} class="toggle-input">
        <span class="toggle-text">${label}</span>
      </label>
    </div>`;
}

function settingsContent(
  account: Record<string, unknown>,
  policy: Record<string, unknown>,
  saved?: string,
  csrf?: string
): string {
  return `
<div class="page-header">
  <h1 class="page-title">Settings</h1>
</div>

${saved === "1" ? `<div class="alert alert-success">Settings saved.</div>` : ""}

<form method="POST" action="/settings">
<input type="hidden" name="_csrf" value="${h(csrf)}">
<div class="settings-grid">

  <!-- Company Profile -->
  <div class="card">
    <div class="card-title">Company Profile</div>
    <div class="form-field">
      <label class="field-label">Company name</label>
      <input type="text" name="company_name" value="${h(account.company_name)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Contact name</label>
      <input type="text" name="contact_name" value="${h(account.contact_name)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Contact email</label>
      <input type="email" name="contact_email" value="${h(account.contact_email)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Contact phone</label>
      <input type="text" name="contact_phone" value="${h(account.contact_phone)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Certificate holder name</label>
      <input type="text" name="certificate_holder_name" value="${h(policy.certificate_holder_name)}" class="field-input">
      <span class="field-hint">Must appear on carrier's COI exactly as written</span>
    </div>
  </div>

  <!-- Insurance Requirements -->
  <div class="card">
    <div class="card-title">Insurance Requirements</div>
    <div class="form-field">
      <label class="field-label">Minimum auto liability ($)</label>
      <input type="number" name="minimum_insurance_auto" value="${String(policy.minimum_insurance_auto || 1000000)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Minimum cargo insurance ($)</label>
      <input type="number" name="minimum_insurance_cargo" value="${String(policy.minimum_insurance_cargo || 100000)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Minimum general liability ($)</label>
      <input type="number" name="minimum_insurance_general" value="${String(policy.minimum_insurance_general || 1000000)}" class="field-input">
    </div>
    <div class="form-field">
      <label class="field-label">Minimum authority age (days)</label>
      <input type="number" name="minimum_authority_age_days" value="${String(policy.minimum_authority_age_days || 180)}" class="field-input">
      <span class="field-hint">180 = 6 months</span>
    </div>
  </div>

  <!-- Hard Stop Requirements -->
  <div class="card">
    <div class="card-title">Hard Stop Requirements</div>
    ${toggle("require_mc_active", !!policy.require_mc_active, "Require active MC / FMCSA operating authority")}
    ${toggle("require_dot_active", !!policy.require_dot_active, "Require active DOT number in good standing")}
    ${toggle("require_w9", !!policy.require_w9, "Require W-9 on file before dispatch")}
    ${toggle("require_signed_agreement", !!policy.require_signed_agreement, "Require signed carrier agreement")}
    ${toggle("coi_required_at_submission", !!policy.coi_required_at_submission, "COI required at time of submission")}
    ${toggle("auto_reject_expired_coi", !!policy.auto_reject_expired_coi, "Auto-reject carriers with expired COI")}
    ${toggle("require_additional_insured", !!policy.require_additional_insured, "Require company listed as additional insured")}
    ${toggle("require_real_time_gps", !!policy.require_real_time_gps, "Require real-time GPS tracking capability")}
    ${toggle("double_brokering_flag_triggers_reject", !!policy.double_brokering_flag_triggers_reject, "Auto-reject carriers with double brokering flag")}
  </div>

  <!-- Dispatch Requirements -->
  <div class="card">
    <div class="card-title">Dispatch Requirements</div>
    ${toggle("require_signed_rate_confirmation", !!policy.require_signed_rate_confirmation, "Require signed rate confirmation before dispatch")}
    ${toggle("require_driver_phone", !!policy.require_driver_phone, "Require driver phone number")}
    ${toggle("require_truck_and_trailer_number", !!policy.require_truck_and_trailer_number, "Require truck and trailer number")}
    ${toggle("require_dispatch_packet", !!policy.require_dispatch_packet, "Require completed dispatch packet before truck rolls")}
    ${toggle("pickup_code_required", !!policy.pickup_code_required, "Require pickup code (SMS to driver at dispatch)")}
    ${toggle("accept_owner_operators", !!policy.accept_owner_operators, "Accept owner-operators")}
    ${toggle("owner_operator_same_requirements", !!policy.owner_operator_same_requirements, "Owner-operators must meet same requirements")}
  </div>

</div>

<div class="settings-save">
  <button type="submit" class="btn-primary">Save Settings</button>
</div>
</form>`;
}
