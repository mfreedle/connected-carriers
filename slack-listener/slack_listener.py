#!/usr/bin/env python3
"""
Connected Carriers — Slack Socket Mode Listener
Watches #cc-agent-logs for CC AGENT directives and fires the headless runner.

Pattern adapted from mfreedle/agent-platform (proven in HONEX Site Services).
Runs as a Railway service — no VPS required for static HTML + MCP stack.

CRITICAL: Private channels use message.groups NOT message.channels.
Bot token scopes required: channels:history, channels:read, groups:history, groups:read, chat:write
Event subscription: message.groups (not message.channels)
"""

import os
import re
import time
import logging
import threading
import subprocess
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

# ── CONFIG ────────────────────────────────────────────────────────
SLACK_BOT_TOKEN     = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN     = os.environ["SLACK_APP_TOKEN"]      # xapp- token for Socket Mode
SLACK_SIGNING_SECRET = os.environ["SLACK_SIGNING_SECRET"]
CC_AGENT_CHANNEL_ID = os.environ.get("CC_AGENT_CHANNEL_ID", "")  # #cc-agent-logs channel ID

# Agent keyword — directives must start with this (case-sensitive)
AGENT_KEYWORD = "CC AGENT"

# Lock file — prevents concurrent agent runs
LOCK_FILE = "/tmp/cc_agent.lock"

# ── BOLT APP ──────────────────────────────────────────────────────
app = App(token=SLACK_BOT_TOKEN, signing_secret=SLACK_SIGNING_SECRET)

def try_acquire_lock() -> bool:
    """Returns True if lock acquired, False if already running."""
    if os.path.exists(LOCK_FILE):
        # Check if the lock is stale (older than 30 minutes)
        age = time.time() - os.path.getmtime(LOCK_FILE)
        if age > 1800:
            log.warning(f"Stale lock detected ({age:.0f}s old) — clearing")
            os.remove(LOCK_FILE)
        else:
            return False
    open(LOCK_FILE, "w").write(str(os.getpid()))
    return True

def release_lock():
    if os.path.exists(LOCK_FILE):
        os.remove(LOCK_FILE)

def post_to_slack(channel: str, text: str):
    """Post a message to Slack."""
    try:
        app.client.chat_postMessage(channel=channel, text=text)
    except Exception as e:
        log.error(f"Failed to post to Slack: {e}")

def fire_agent(directive_text: str, channel_id: str):
    """Run the CC agent headlessly with the directive."""
    if not try_acquire_lock():
        post_to_slack(channel_id, ":warning: CC Agent is already running. Wait for it to complete.")
        return

    try:
        post_to_slack(channel_id, f":robot_face: CC Agent received directive — starting...")
        log.info(f"Firing agent with directive: {directive_text[:100]}...")

        # Build the Claude CLI command
        # The agent reads the directive and executes it with MCP tool access
        prompt = f"""You are the CC Agent for Connected Carriers (mfreedle/connected-carriers).
Execute this directive posted to #cc-agent-logs:

{directive_text}

Rules:
- Push all changes to GitHub using the API (token in your instructions)
- Post results back to this Slack channel ({channel_id})
- Follow all rules in .claude/CLAUDE.md
- Always get current SHA before updating files
"""

        result = subprocess.run(
            ["claude", "-p", prompt,
             "--allowedTools", "Bash,Read,Write,Edit",
             "--dangerously-skip-permissions"],
            capture_output=True,
            text=True,
            timeout=600  # 10 minute max
        )

        if result.returncode == 0:
            post_to_slack(channel_id, f":white_check_mark: CC Agent completed.
{result.stdout[-2000:] if result.stdout else 'No output'}")
        else:
            post_to_slack(channel_id, f":x: CC Agent failed (exit {result.returncode}).
```{result.stderr[-1000:]}```")

    except subprocess.TimeoutExpired:
        post_to_slack(channel_id, ":alarm_clock: CC Agent timed out after 10 minutes.")
    except Exception as e:
        post_to_slack(channel_id, f":x: CC Agent error: {str(e)}")
        log.exception("Agent execution error")
    finally:
        release_lock()

# ── EVENT HANDLER ─────────────────────────────────────────────────
@app.event("message")
def handle_message(event, say):
    """
    Listen for CC AGENT directives in the agent channel.
    Uses message.groups subscription for private channels.
    """
    channel = event.get("channel", "")
    text    = event.get("text", "")
    subtype = event.get("subtype", "")

    # Ignore bot messages, edits, deletes
    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return

    # Only process messages from the designated agent channel
    if CC_AGENT_CHANNEL_ID and channel != CC_AGENT_CHANNEL_ID:
        return

    # Only fire on CC AGENT directives
    if not text.strip().startswith(AGENT_KEYWORD):
        return

    log.info(f"CC AGENT directive detected in {channel}")

    # Extract directive text (everything after the keyword)
    directive = text[len(AGENT_KEYWORD):].strip()
    if not directive:
        post_to_slack(channel, ":warning: Directive was empty. Add instructions after CC AGENT.")
        return

    # Fire the agent in a background thread so Slack doesn't time out
    thread = threading.Thread(
        target=fire_agent,
        args=(directive, channel),
        daemon=True
    )
    thread.start()

# ── MAIN ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("Connected Carriers Slack listener starting...")
    log.info(f"Watching channel: {CC_AGENT_CHANNEL_ID or 'ALL channels'}")
    log.info(f"Trigger keyword: {AGENT_KEYWORD}")

    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()
