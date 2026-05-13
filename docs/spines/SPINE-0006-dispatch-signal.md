# SPINE-0006: Dispatch Signal Spine

## Purpose

The dispatch signal spine confirms that the assigned driver is actually at or near the pickup location at the right time.

## User Promise

The broker gets a simple signal after dispatch: the driver is on site, close enough to review, too far away, or not responding.

## Trigger

Dispatch signal starts after a carrier is assigned and cleared enough to proceed. If the carrier has a current complete profile, assignment may skip document chase and go directly to signal.

## Required Data

- Original load ID
- Assignment ID when available
- Carrier ID
- Driver phone
- Broker account ID
- Exact pickup address
- Structured pickup window start/end
- Geocoded pickup latitude/longitude
- Confirmation token
- Driver confirmation location
- Geofence result

## Required Flow

1. System receives assignment/dispatch context.
2. System uses exact pickup address, not just origin city.
3. System geocodes pickup address.
4. System sends driver arrival confirmation link.
5. Driver confirms arrival from phone.
6. System compares driver location to pickup coordinates.
7. Broker sees green/yellow/red/no-response status.

## Signal States

- `arrival_sent`: link sent, waiting on driver.
- `on_site`: driver confirmed within accepted radius.
- `review_location`: driver is close but needs broker review.
- `location_alert`: driver is too far away.
- `no_response`: reminders exhausted or pickup window approaching.
- `sms_failed`: message could not be delivered.
- `superseded`: assignment changed.

## UI Promise

The broker should see:

- Whether the driver responded.
- Whether the driver appears to be at pickup.
- Whether it is safe to release/load.
- Whether to call or reassign.

## Failure States

- Missing exact pickup address.
- Pickup window is not structured.
- Geocoding fails.
- Driver phone missing or invalid.
- Driver denies location permission.
- Driver confirms from far away.
- Assignment changes after signal is sent.

## Must Never Happen

- City-level coordinates are treated as exact pickup location.
- Dispatch signal is created without a link back to the original load/assignment.
- Old assigned carriers keep active arrival requests after reassignment.
- No-response state is invisible to broker.

## Current Gaps To Resolve

- Pickup address is collected but not consistently stored/displayed in dispatch verification.
- Pickup window is collected as text but not reliably used by reminder logic.
- Dispatch verification currently uses a generated load ID that may not map back to the original load row.
