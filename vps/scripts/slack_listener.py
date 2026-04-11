#!/usr/bin/env python3
"""
Connected Carriers — Slack Socket Mode Listener
Watches #cc-agent-logs for CC AGENT directives.

Fast-path handlers (no headless agent spin-up):
  CC AGENT — lookup MC<number>      → hits MCP server, posts verify + tier result

General directives (everything else):
  CC AGENT — <anything>             → fires headless_cc_directive.sh

Install at: /home/connected-carriers/scripts/slack_listener.py
"""

import os
import re
import json
import subprocess
import threading
import time
import fcntl
import logging
import urllib.request
import urllib.error
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

CHANNEL_ID  = "C0ARDH1B86S"   # #cc-agent-logs
REPO_DIR    = "/home/connected-carriers"
LOCK_FILE   = "/tmp/cc_agent.lock"
MCP_URL     = "https://cc-mcp-server-production.up.railway.app/mcp"
STARTUP_TS  = str(time.time())

app = App(
    token=os.environ["SLACK_BOT_TOKEN"],
    signing_secret=os.environ["SLACK_SIGNING_SECRET"],
)

handled_timestamps: set = set()
_lock_fd = None


# ── Lock helpers ──────────────────────────────────────────────────

def try_acquire_lock():
    global _lock_fd
    try:
        _lock_fd = open(LOCK_FILE, "w")
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_fd.write(str(os.getpid()))
        _lock_fd.flush()
        return True
    except (IOError, OSError):
        if _lock_fd:
            _lock_fd.close()
            _lock_fd = None
        return False


def release_lock():
    global _lock_fd
    if _lock_fd:
        try:
            fcntl.flock(_lock_fd, fcntl.LOCK_UN)
            _lock_fd.close()
        except Exception:
            pass
        _lock_fd = None
    try:
        os.remove(LOCK_FILE)
    except FileNotFoundError:
        pass


# ── Slack helpers ─────────────────────────────────────────────────

def post_to_slack(text: str, thread_ts: str = None):
    try:
        kwargs = dict(channel=CHANNEL_ID, text=text)
        if thread_ts:
            kwargs["thread_ts"] = thread_ts
        app.client.chat_postMessage(**kwargs)
    except Exception as e:
        logger.error(f"Failed to post to Slack: {e}")


# ── MCP helpers ───────────────────────────────────────────────────

def mcp_call(method: str, params: dict) -> dict:
    """Send a single JSON-RPC request to the MCP server. Returns result dict or raises."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode()
    req = urllib.request.Request(
        MCP_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode()

    # StreamableHTTP returns SSE lines: "data: {...}"
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = json.loads(line[5:].strip())
            if "error" in data:
                raise RuntimeError(f"MCP error: {data['error']}")
            return data.get("result", {})
    raise RuntimeError(f"No data in MCP response: {raw[:200]}")


def mcp_tool_call(tool_name: str, arguments: dict) -> str:
    """Initialize MCP session, call a tool, return text content."""
    mcp_call("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "cc-slack-listener", "version": "1.0"},
    })
    result = mcp_call("tools/call", {"name": tool_name, "arguments": arguments})
    for block in result.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    return json.dumps(result)


# ── Fast-path: MC lookup ──────────────────────────────────────────

def handle_mc_lookup(mc_number: str, thread_ts: str):
    """Run cc_verify_carrier + cc_assign_tier, post formatted result to Slack."""
    post_to_slack(f":mag: Looking up MC{mc_number}…", thread_ts=thread_ts)
    try:
        # Step 1: verify
        verify_raw = mcp_tool_call("cc_verify_carrier", {"mc_number": mc_number})
        verify  = json.loads(verify_raw)
        fmcsa   = verify.get("fmcsa", {})
        checks  = verify.get("checks", {})
        passed  = checks.get("overall_pass", False)
        active  = fmcsa.get("active", False)
        name    = fmcsa.get("entity_name") or "Unknown"
        address = fmcsa.get("physical_address") or "—"
        rating  = fmcsa.get("safety_rating") or "Not Rated"
        oos     = fmcsa.get("out_of_service_date")
        years   = fmcsa.get("years_in_operation")
        auth    = fmcsa.get("operating_status", "—")

        # Step 2: tier
        has_safety_flag  = (rating == "Unsatisfactory") or bool(oos)
        failed_hard_stop = not passed

        tier_raw  = mcp_tool_call("cc_assign_tier", {
            "mc_number":           mc_number,
            "in_port_tms":         False,
            "completed_loads":     0,
            "verification_passed": bool(passed),
            "has_safety_flag":     has_safety_flag,
            "failed_hard_stop":    failed_hard_stop,
        })
        tier_data = json.loads(tier_raw)
        tier   = tier_data.get("tier", "Unknown")
        reason = tier_data.get("reason", "")

        # Icons
        status_icon = ":white_check_mark:" if active else ":x:"
        tier_icon   = (
            ":star:"                if "Tier 1" in tier else
            ":large_green_circle:"  if "Tier 2" in tier else
            ":large_yellow_circle:" if "Tier 3" in tier else
            ":no_entry:"
        )

        check_map = {
            "found_in_fmcsa":           "Found in FMCSA",
            "active_authority":         "Active authority",
            "authorized_for_hire":      "Authorized for hire",
            "no_unsatisfactory_rating": "No unsatisfactory rating",
            "not_out_of_service":       "Not out of service",
            "meets_min_years":          "Meets min years",
        }
        check_lines = [
            f"  {'✅' if checks[k] else '❌'} {label}"
            for k, label in check_map.items() if k in checks
        ]

        msg = (
            f"*CC Carrier Lookup — MC{mc_number}*\n"
            f"{status_icon} *{name}*\n"
            f":round_pushpin: {address}\n"
            f":shield: Authority: {auth}  |  Safety: {rating}"
            + (f"  |  {years} yrs in operation" if years is not None else "")
            + (f"\n:warning: *Out of service:* {oos}" if oos else "")
            + "\n\n*Verification checks:*\n"
            + "\n".join(check_lines)
            + f"\n\n{tier_icon} *Tier: {tier}*\n_{reason}_"
        )
        post_to_slack(msg, thread_ts=thread_ts)

    except Exception as e:
        logger.exception(f"MC lookup failed for MC{mc_number}")
        post_to_slack(f":x: Lookup failed for MC{mc_number}: {e}", thread_ts=thread_ts)


# ── General directive: headless agent ────────────────────────────

def fire_headless(directive_text: str):
    if not try_acquire_lock():
        post_to_slack(":warning: *CC Agent* is already running. Wait for it to complete.")
        return
    try:
        script = os.path.join(REPO_DIR, "scripts", "headless_cc_directive.sh")
        env = os.environ.copy()
        env["DIRECTIVE_TEXT"] = directive_text
        subprocess.Popen(
            ["bash", script],
            env=env,
            stdout=open(os.path.join(REPO_DIR, "logs", "headless_cc.log"), "a"),
            stderr=subprocess.STDOUT,
        )
        logger.info(f"Fired headless script: {directive_text[:80]}")
    except Exception as e:
        release_lock()
        post_to_slack(f":x: *CC Agent* — failed to fire headless script: {e}")
        logger.exception("Failed to fire headless script")


# ── Message handler ───────────────────────────────────────────────

@app.event("message")
def handle_message(event, say):
    channel = event.get("channel", "")
    text    = event.get("text", "") or ""
    subtype = event.get("subtype", "")
    ts      = event.get("ts", "")

    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return
    if channel != CHANNEL_ID:
        return
    if ts and float(ts) < float(STARTUP_TS):
        return
    if ts in handled_timestamps:
        return
    handled_timestamps.add(ts)

    if not text.strip().startswith("CC AGENT"):
        return

    directive = text[len("CC AGENT"):].strip().lstrip("—").lstrip("-").strip()
    if not directive:
        post_to_slack(":warning: Empty directive. Add instructions after `CC AGENT —`.")
        return

    logger.info(f"CC AGENT directive: {directive[:80]}")

    # Fast-path: lookup MC<number>
    mc_match = re.match(r"^lookup\s+MC(\d+)$", directive, re.IGNORECASE)
    if mc_match:
        mc_number = mc_match.group(1)
        logger.info(f"Fast-path MC lookup: MC{mc_number}")
        threading.Thread(
            target=handle_mc_lookup,
            args=(mc_number, ts),
            daemon=True,
        ).start()
        return

    # General: fire headless agent
    threading.Thread(target=fire_headless, args=(directive,), daemon=True).start()


# ── Startup ───────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info("Connected Carriers Slack listener starting…")
    logger.info(f"Channel: {CHANNEL_ID}")
    logger.info(f"MCP URL: {MCP_URL}")
    logger.info(f"Repo dir: {REPO_DIR}")
    handler = SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"])
    handler.start()
