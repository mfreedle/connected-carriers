/**
 * ============================================================
 *  HONEX Connected Carriers — Carrier Qualification Form Builder
 * ============================================================
 *
 *  HOW TO RUN:
 *  1. Go to script.google.com
 *  2. Click "New Project"
 *  3. Delete any existing code in the editor
 *  4. Paste this entire script
 *  5. Click Save (Ctrl+S / Cmd+S)
 *  6. In the function dropdown at the top, select "createForm"
 *  7. Click Run
 *  8. Click "Review permissions" then "Allow"
 *  9. Check the Execution Log at the bottom for the live form URL
 * 10. The form also appears automatically in your Google Drive
 *
 *  Multiple team members can each submit their own responses.
 *  All responses collect in a linked Google Sheet automatically.
 * ============================================================
 */

function createForm() {

  var form = FormApp.create('HONEX Connected Carriers — Carrier Qualification Profile');

  form.setDescription(
    'HONEX Connected Carriers\n\n' +
    'This qualification profile defines your carrier vetting standards. ' +
    'Your answers configure your automated Connected Carriers screening portal — ' +
    'so carriers who don\'t meet your standards never reach your team.\n\n' +
    'Multiple team members can each fill this out separately. ' +
    'All responses are collected together.\n\n' +
    'Estimated time: 10–15 minutes.'
  );

  form.setConfirmationMessage(
    'Thank you — your responses have been recorded.\n\n' +
    'The HONEX Connected Carriers team will review your profile and follow up within 1 business day.'
  );

  form.setCollectEmail(true);
  form.setAllowResponseEdits(true);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);

  // ── PAGE 0: WHO IS FILLING THIS OUT ───────────────────────────
  form.addSectionHeaderItem()
    .setTitle('About You')
    .setHelpText('Tell us who is completing this section. Multiple people from your team can submit separately.');

  form.addTextItem()
    .setTitle('Your Full Name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Your Role / Title')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Which parts of the carrier vetting process do you own or have opinions on?')
    .setRequired(false)
    .setHelpText('e.g. "I handle compliance and insurance" or "I manage dispatch and carrier relationships"');

  // ── PAGE 1: COMPLIANCE ────────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 1 — Compliance & Legal Authority')
    .setHelpText(
      'These are your HARD STOPS.\n\n' +
      'If a carrier fails any of these, the portal rejects them instantly — ' +
      'no human review, no wasted time. Answer Yes to enforce it as a requirement.'
    );

  var yn = ['Yes — require this', 'No — skip this'];

  form.addMultipleChoiceItem()
    .setTitle('Require active FMCSA operating authority (MC number)?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText(
      'Recommended: Yes.\n' +
      'The portal verifies this automatically via the FMCSA SAFER public API ' +
      'the moment a carrier submits — no manual lookup needed.'
    );

  form.addMultipleChoiceItem()
    .setTitle('Require active DOT number in good standing?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Also verified automatically via FMCSA SAFER API at time of submission.');

  form.addMultipleChoiceItem()
    .setTitle('Require carrier to already be in your Port TMS system?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText(
      'If Yes: carriers already in Port TMS are fast-tracked to Tier 1 (Preferred) automatically.\n' +
      'If No: new carriers can still qualify through the full vetting process.'
    );

  form.addMultipleChoiceItem()
    .setTitle('Require no Unsatisfactory FMCSA safety rating?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Recommended: Yes. Auto-reject any carrier rated Unsatisfactory by FMCSA.');

  form.addMultipleChoiceItem()
    .setTitle('Should a Conditional FMCSA safety rating trigger manual review (rather than auto-reject)?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText(
      'If Yes: Conditional-rated carriers go to Tier 3 (manual review queue) instead of being rejected outright.\n' +
      'If No: Conditional-rated carriers are treated the same as Satisfactory.'
    );

  form.addMultipleChoiceItem()
    .setTitle('Require W-9 on file before dispatch?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Require signed carrier agreement on file before dispatch?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('The portal can send your carrier agreement for e-signature automatically.');

  form.addMultipleChoiceItem()
    .setTitle('Minimum time the carrier must have been in business:')
    .setChoiceValues(['No minimum', '6+ months', '1+ year', '2+ years', 'Other (describe below)'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('If "Other" — describe your minimum time in business requirement:')
    .setRequired(false);

  // ── PAGE 2: INSURANCE ─────────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 2 — Insurance Requirements')
    .setHelpText(
      'Set your minimum thresholds. Carriers below these are automatically rejected.\n\n' +
      'Note on verification: There is no direct API into insurance companies. ' +
      'The portal verifies coverage two ways:\n' +
      '1. FMCSA SAFER API (free) — confirms minimum coverage on federal record.\n' +
      '2. Highway or SaferWatch (optional paid add-on) — real-time alerts when coverage lapses.\n' +
      'Certificates of insurance (PDFs) submitted by carriers are reviewed manually or via OCR.'
    );

  form.addTextItem()
    .setTitle('Minimum Auto Liability ($)')
    .setRequired(false)
    .setHelpText('e.g. 1000000 — industry standard is $1,000,000. Leave blank if not required.');

  form.addTextItem()
    .setTitle('Minimum Cargo Insurance ($)')
    .setRequired(false)
    .setHelpText('e.g. 100000. Leave blank if not required.');

  form.addTextItem()
    .setTitle('Minimum General Liability ($)')
    .setRequired(false)
    .setHelpText('Leave blank if not required.');

  form.addTextItem()
    .setTitle('Certificate of insurance must name as certificate holder:')
    .setRequired(false)
    .setHelpText('e.g. Logistics Xpress LLC — this exact name must appear on the carrier\'s COI');

  form.addMultipleChoiceItem()
    .setTitle('Require your company listed as additional insured on the certificate?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Auto-reject carriers with expired certificates?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Recommended: Yes.');

  form.addMultipleChoiceItem()
    .setTitle('When must the certificate of insurance be provided?')
    .setChoiceValues([
      'Required at time of submission — no COI, no entry',
      'Required before first dispatch — can submit without it initially',
      'Verified during our onboarding call — manual review step'
    ])
    .setRequired(true);

  // ── PAGE 3: EQUIPMENT ─────────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 3 — Equipment & Capacity')
    .setHelpText(
      'This tells the portal which equipment types to accept from carriers ' +
      'and what questions to ask during the submission process.'
    );

  form.addCheckboxItem()
    .setTitle('Equipment types you work with (check all that apply):')
    .setChoiceValues([
      "Dry Van 53'",
      "Reefer / Refrigerated 53'",
      'Flatbed',
      'Step Deck',
      'RGN / Lowboy',
      'Power Only',
      'Sprinter / Cargo Van',
      'Box Truck',
      'LTL (Less Than Truckload)',
      'Intermodal / Drayage',
      'Specialized / Oversized',
      'Ocean / International Freight'
    ])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Any other equipment types not listed above:')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Require carrier to own (not lease) their equipment?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Do you accept owner-operators?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Owner-operators are independent drivers who own their own truck and operate under their own authority.');

  form.addTextItem()
    .setTitle('If owner-operators accepted — any additional requirements for them?')
    .setRequired(false)
    .setHelpText('e.g. minimum 2 years experience, must have own authority, must be on approved list');

  form.addTextItem()
    .setTitle('Minimum number of trucks in fleet (leave blank if no minimum):')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Maximum acceptable truck age in years (leave blank if no maximum):')
    .setRequired(false);

  // ── PAGE 4: PERFORMANCE ───────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 4 — Performance Standards & Experience')
    .setHelpText(
      'These criteria determine whether a new carrier gets approved, ' +
      'flagged for manual review, or rejected based on their track record.'
    );

  form.addTextItem()
    .setTitle('Minimum on-time delivery rate required (%)  — leave blank if not required:')
    .setRequired(false)
    .setHelpText('e.g. 95');

  form.addTextItem()
    .setTitle('Minimum number of completed loads in history — leave blank if no minimum:')
    .setRequired(false)
    .setHelpText('e.g. 50');

  form.addMultipleChoiceItem()
    .setTitle('Require references from other freight brokers or shippers?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addTextItem()
    .setTitle('If references required — how many?')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Run carrier verification on CarrierWatch / SaferWatch / MyCarrierPackets?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('If Yes, the portal can run this check automatically via API (paid service add-on).');

  form.addMultipleChoiceItem()
    .setTitle('Require prior experience on specific lanes or freight types?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('e.g. carrier must have run CA→TX before, or have Hazmat endorsement, or temp-controlled experience');

  form.addTextItem()
    .setTitle('If lane/freight experience required — describe:')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Require ELD (Electronic Logging Device) compliance?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Required by federal law for most carriers. Selecting Yes confirms this is a hard stop.');

  form.addMultipleChoiceItem()
    .setTitle('Require GPS / real-time tracking capability?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('If Yes, carriers without GPS tracking are auto-rejected.');

  form.addMultipleChoiceItem()
    .setTitle('Require carrier to accept check calls / status updates during transit?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How often do you require check calls or tracking updates?')
    .setChoiceValues([
      'Every 2 hours',
      'Every 4 hours',
      'Pickup + Delivery confirmation only',
      'Real-time GPS required — no manual check calls',
      'As needed / load dependent',
      'No requirement'
    ])
    .setRequired(false);

  // ── PAGE 5: RATES & PAYMENT ───────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 5 — Rate Submission & Payment Terms')
    .setHelpText(
      'This section configures what carriers must include when they submit a rate on a load, ' +
      'and what payment terms they\'ll see when working with you.'
    );

  form.addCheckboxItem()
    .setTitle('What must a carrier include when submitting a rate? (check all that apply)')
    .setChoiceValues([
      'All-in rate (required)',
      'Fuel surcharge broken out separately',
      'Accessorial charges broken out',
      'Equipment details (type, size)',
      'Available pickup time / window',
      'Driver name and direct contact number',
      'Truck number and trailer number',
      'Estimated transit days',
      'Confirmation of origin and destination'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Preferred method for carriers to submit rates:')
    .setChoiceValues([
      'Web portal / online form (preferred)',
      'Email with rate confirmation',
      'Phone call + follow-up email confirmation',
      'TMS bid board (Port TMS)',
      'Load board response (DAT, Truckstop, etc.)'
    ])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Standard payment terms (days):')
    .setRequired(false)
    .setHelpText('e.g. Net 30, Net 45');

  form.addMultipleChoiceItem()
    .setTitle('Do you offer quick pay?')
    .setChoiceValues(['Yes', 'No'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('If quick pay offered — fee (%):')
    .setRequired(false)
    .setHelpText('e.g. 2.5%');

  form.addMultipleChoiceItem()
    .setTitle('Do you work with carriers who use factoring companies?')
    .setChoiceValues(['Yes', 'No', 'Case by case'])
    .setRequired(true)
    .setHelpText('Factoring companies pay carriers immediately and collect from the broker later.');

  form.addMultipleChoiceItem()
    .setTitle('Require rate confirmed in writing before dispatch?')
    .setChoiceValues(yn)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Require signed rate confirmation before truck rolls?')
    .setChoiceValues(yn)
    .setRequired(true)
    .setHelpText('Recommended: Yes. The portal can send rate confirmations for e-signature automatically.');

  // ── PAGE 6: AUTO-REJECT ───────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 6 — Automatic Disqualifiers')
    .setHelpText(
      'Check every condition that should result in INSTANT rejection — ' +
      'no human review, no exceptions.\n\n' +
      'The portal enforces these automatically the moment a carrier submits. ' +
      'Your team never sees these carriers.'
    );

  form.addCheckboxItem()
    .setTitle('Auto-reject a carrier if ANY of these are true: (check all that apply)')
    .setChoiceValues([
      'Inactive MC / DOT operating authority',
      'Unsatisfactory FMCSA safety rating',
      'Conditional FMCSA safety rating (if not sending to Tier 3 review)',
      'Insurance expired',
      'Insurance below minimum threshold',
      'Less than minimum time in business',
      'No W-9 on file',
      'No signed carrier agreement on file',
      'Unresolved cargo claim on record',
      'Carrier is on our internal do-not-use list',
      'No GPS / real-time tracking capability',
      'Rate submitted above our maximum threshold',
      'Submitted wrong equipment type for our freight',
      'Failed reference check'
    ])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Any other automatic disqualifiers not listed above:')
    .setRequired(false);

  // ── PAGE 7: CARRIER TIERS ─────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 7 — Carrier Tiers')
    .setHelpText(
      'The portal assigns every carrier to a tier automatically based on their submission.\n\n' +
      '★  TIER 1 — PREFERRED\n' +
      'Who qualifies: Already in your Port TMS with a clean history — 3+ completed loads, ' +
      'no cargo claims, current insurance. You\'ve worked with them and they delivered.\n' +
      'What happens: Bypasses the screening queue entirely. Your team sees them as pre-approved immediately. ' +
      'Fastest path to dispatch.\n\n' +
      '✓  TIER 2 — APPROVED\n' +
      'Who qualifies: Brand new carrier, never worked with you, but passes every single hard stop and requirement — ' +
      'active MC/DOT, insurance meets minimums, no safety flags, signed agreement submitted.\n' +
      'What happens: Added to your approved carrier pool. Your team is notified. ' +
      'Standard onboarding steps (e-sign agreement, COI upload) complete before first load.\n\n' +
      '⚠  TIER 3 — CONDITIONAL\n' +
      'Who qualifies: Passes the minimums but has something that needs a closer look — ' +
      'conditional safety rating, one missing document, insurance close to threshold, ' +
      'incomplete history, or any item you\'ve flagged for manual review.\n' +
      'What happens: Goes into a review queue. Your team receives an alert to manually ' +
      'approve or reject before the carrier can proceed.\n\n' +
      '✗  REJECTED\n' +
      'Who qualifies: Fails one or more items from Section 6.\n' +
      'What happens: Instantly rejected. Optional automated response sent to the carrier. ' +
      'No human time spent. Carrier cannot resubmit without changes.'
    );

  form.addMultipleChoiceItem()
    .setTitle('Should the portal automatically assign carrier tiers based on these criteria?')
    .setChoiceValues(['Yes — automate tier assignment', 'No — we will review and assign tiers manually'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Tier 1 (Preferred) — any adjustments to the criteria above?')
    .setRequired(false)
    .setHelpText('e.g. minimum 10 loads instead of 3, or specific lanes required');

  form.addTextItem()
    .setTitle('Tier 2 (Approved) — any adjustments or additional requirements?')
    .setRequired(false)
    .setHelpText('e.g. require a phone call before approving all new carriers');

  form.addTextItem()
    .setTitle('Tier 3 (Conditional) — what specifically should trigger a manual review?')
    .setRequired(false)
    .setHelpText('e.g. conditional safety rating, insurance within 10% of minimum, missing one document');

  // ── PAGE 8: NOTIFICATIONS ─────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 8 — Notifications')
    .setHelpText(
      'Tell us who on your team should be alerted when carriers pass or fail screening, ' +
      'and how qualified or rejected carriers should be notified.'
    );

  form.addTextItem()
    .setTitle('Name and email of person to notify when a carrier passes screening:')
    .setRequired(false)
    .setHelpText('e.g. Kate Gonzalez — kate@logisticsxpress.com');

  form.addTextItem()
    .setTitle('Name and email of second person to notify (if any):')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('How should QUALIFIED carriers be notified they passed?')
    .setChoiceValues([
      'Automated email with next steps (recommended)',
      'Text message',
      'Our team calls them personally',
      'They check their status in the portal',
      'No notification — our team handles outreach'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How should REJECTED carriers be notified?')
    .setChoiceValues([
      'Automated email — generic language, no specific reason cited',
      'No notification sent to carrier',
      'Our team handles it case by case'
    ])
    .setRequired(true)
    .setHelpText('Recommended: generic automated email. Giving specific rejection reasons can invite disputes.');

  // ── PAGE 9: DISPATCH ──────────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 9 — Dispatch Verification')
    .setHelpText(
      'This section is for the DISPATCH step — after a carrier is approved and a load is tendered.\n\n' +
      'At dispatch, the portal collects truck, driver, and VIN information to verify ' +
      'the vehicle showing up actually belongs to the carrier you booked.\n\n' +
      'This is your primary defense against double-brokering and cargo theft fraud.'
    );

  form.addCheckboxItem()
    .setTitle('What should your team verify before a truck rolls? (check all that apply)')
    .setChoiceValues([
      'Driver name matches rate confirmation',
      'Truck and trailer number confirmed with carrier',
      'VIN verified against carrier\'s FMCSA registered fleet',
      'Insurance re-verified as active at moment of dispatch',
      'Signed rate confirmation received',
      'Driver cell phone confirmed and reachable',
      'Pickup appointment confirmed with shipper',
      'Load number / reference number given to driver',
      'Check call schedule confirmed with driver',
      'Carrier re-checked against do-not-use list (final check)'
    ])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Which automated VIN / dispatch verification checks should the portal run?')
    .setChoiceValues([
      'VIN vs. FMCSA registered fleet for that MC number',
      'Flag if VIN is not registered to the approved carrier',
      'Re-verify insurance is still active at moment of dispatch',
      'VIN vs. CargoNet stolen vehicle database',
      'Alert team immediately if any check fails before truck rolls'
    ])
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Which verification service would you like to use for dispatch checks?')
    .setChoiceValues([
      'Highway (highway.com) — all-in-one carrier verification',
      'CargoNet — stolen vehicle and cargo theft database',
      'FMCSA SAFER API — free federal data only',
      'MyCarrierPackets — full carrier onboarding suite',
      'Not sure yet — advise us'
    ])
    .setRequired(false);

  form.addTextItem()
    .setTitle('Any other notes on your dispatch verification process:')
    .setRequired(false);

  // ── PAGE 10: SPECIAL CASES ────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 10 — Special Cases & Current Process')
    .setHelpText(
      'Help us understand anything unique about your operation ' +
      'and what you\'re working with today.'
    );

  form.addParagraphTextItem()
    .setTitle('Are there any lanes, customers, or load types with DIFFERENT qualification requirements?')
    .setRequired(false)
    .setHelpText('e.g. Hazmat loads require Hazmat endorsement; Reefer requires temp monitoring capability; Ocean requires different insurance minimums');

  form.addParagraphTextItem()
    .setTitle('How do you currently vet carriers today? Describe your existing process.')
    .setRequired(false)
    .setHelpText('Even if it\'s informal — walk us through what actually happens when a new carrier calls in');

  form.addParagraphTextItem()
    .setTitle('What are the biggest pain points with your current carrier intake process?')
    .setRequired(false)
    .setHelpText('Be as specific as possible — this directly shapes what we build first');

  form.addParagraphTextItem()
    .setTitle('Anything else we should know before we build your Connected Carriers portal?')
    .setRequired(false);

  // ── PAGE 11: SAAS & TOOLS ─────────────────────────────────────
  form.addPageBreakItem()
    .setTitle('Section 11 — Current Software & Tools')
    .setHelpText(
      'So we build integrations — not replacements.\n\n' +
      'Tell us what your team already uses every day. ' +
      'This ensures HONEX Connected Carriers connects to your existing workflow ' +
      'rather than adding more tools to manage.'
    );

  form.addCheckboxItem()
    .setTitle('TMS — Transportation Management System:')
    .setChoiceValues([
      'Port TMS',
      'McLeod',
      'Turvo',
      'Aljex',
      'Tai TMS',
      'Rose Rocket',
      'Magaya',
      'None — using spreadsheets',
      'Other (describe below)'
    ])
    .setRequired(true);

  form.addTextItem()
    .setTitle('If "Other" TMS — which one?')
    .setRequired(false);

  form.addCheckboxItem()
    .setTitle('Load Boards you use:')
    .setChoiceValues([
      'DAT',
      'Truckstop / ITS',
      '123Loadboard',
      'Sylectus',
      'Convoy',
      'Loadsmart',
      'Direct outreach only — no load boards',
      'Other'
    ])
    .setRequired(false);

  form.addCheckboxItem()
    .setTitle('Carrier onboarding / compliance tools you currently use:')
    .setChoiceValues([
      'MyCarrierPackets',
      'Highway',
      'SaferWatch',
      'CargoNet',
      'RMIS',
      'Carrier411',
      'Nothing formal — manual process',
      'Other'
    ])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Email & communication tools:')
    .setChoiceValues([
      'Gmail / Google Workspace',
      'Outlook / Microsoft 365',
      'Shared inbox (Frontapp, Helpscout, etc.)',
      'Slack',
      'Microsoft Teams',
      'Text / SMS only',
      'Other'
    ])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Accounting & invoicing:')
    .setChoiceValues([
      'QuickBooks Online',
      'QuickBooks Desktop',
      'Xero',
      'Billing handled inside TMS',
      'Excel / manual',
      'Other'
    ])
    .setRequired(false);

  form.addCheckboxItem()
    .setTitle('Document storage:')
    .setChoiceValues([
      'Google Drive',
      'Dropbox',
      'SharePoint / OneDrive',
      'Email folders',
      'Physical / paper files',
      'Other'
    ])
    .setRequired(false);

  form.addCheckboxItem()
    .setTitle('CRM / customer tracking:')
    .setChoiceValues([
      'Salesforce',
      'HubSpot',
      'Zoho',
      'Handled inside TMS',
      'Spreadsheet / manual',
      'Nothing formal',
      'Other'
    ])
    .setRequired(false);

  form.addTextItem()
    .setTitle('How many people on your team use these tools daily?')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Is anyone on your team technical? (can run scripts, manage software, use APIs)')
    .setChoiceValues(['Yes', 'No', 'Not sure'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Primary operating system your team uses:')
    .setChoiceValues(['Windows', 'Mac', 'Mix of both', 'Mostly mobile / tablet'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Any tools you wish you had but don\'t currently:')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Anything on this list you\'re actively looking to replace:')
    .setRequired(false);

  // ── DONE — LOG THE URL ────────────────────────────────────────
  var url = form.getPublishedUrl();
  var editUrl = form.getEditUrl();

  Logger.log('==============================================');
  Logger.log('HONEX Connected Carriers form created!');
  Logger.log('==============================================');
  Logger.log('Share this URL with your team:');
  Logger.log(url);
  Logger.log('');
  Logger.log('Edit the form here:');
  Logger.log(editUrl);
  Logger.log('');
  Logger.log('Responses will appear in Google Drive');
  Logger.log('as a linked Google Sheet automatically.');
  Logger.log('==============================================');

  // Link a response spreadsheet
  form.setDestination(FormApp.DestinationType.SPREADSHEET,
    SpreadsheetApp.create('HONEX Connected Carriers — Responses').getId());

}
