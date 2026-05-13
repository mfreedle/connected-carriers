# ADR-0003: Authentication and Broker Access

## Status

Accepted.

## Context

The broker portal lives at `app.connectedcarriers.org`. The marketing site lives at `connectedcarriers.org` and should route brokers to the app login.

This ADR is now interpreted through the product spine architecture in `docs/spines/`. The broker app is the system of record and owns authenticated broker workflows.

## Decision

Broker users authenticate through the broker app at `/login`.

Broker accounts may be seeded for pilots or created later through an onboarding flow. Broker users are stored in `broker_users`, with bcrypt-hashed passwords and role-based session access.

Password reset is SMS-based:

1. Broker enters email at `/forgot-password`.
2. System looks up the broker account contact phone.
3. System sends a 6-digit code via Twilio.
4. Code expires after 15 minutes.
5. Broker enters code and new password at `/verify-code`.
6. Password is updated after successful code verification.

## Security Rules

- Limit reset code generation to 3 codes per hour.
- Lock a reset code after 5 bad attempts.
- Store passwords as bcrypt hashes only.
- Keep session auth role-aware with owner, ops, and reviewer roles.
- Broker-owned mutations require authenticated sessions and CSRF protection.
- Public carrier routes may be anonymous only when they are load-scoped or token-scoped.
- Public routes must not be allowed to assign carriers or mutate broker-owned state beyond carrier application/profile submission.

## Existing Behavior

- `/login` works.
- Marketing site sign-in points to the broker login.
- SMS password reset flow is deployed.
- Session auth with roles works.
- Kate's seeded account exists for Logistics Xpress.

## Pilot Account

Kate's seeded login email is:

- Email: `kateloads@logisticsxpress.com`

Kate should use the SMS forgot-password flow if she needs a password reset. The seeded Logistics Xpress contact phone is `310-980-5184`.

## Implementation Notes

- Do not route existing brokers through public anonymous load creation when they have an account.
- Broker-created loads should live in the broker app database, be tied to the broker account, and be shown in the broker dashboard.
- Public marketing links should distinguish broker sign-in from carrier verification.
- MCP, if retained, should be a public edge or compatibility layer and should not own canonical broker workflow data.
