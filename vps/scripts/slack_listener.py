#!/usr/bin/env python3
"""
Connected Carriers — Slack Socket Mode Listener
Watches #cc-agent-logs for CC AGENT directives and fires headless_cc_directive.sh.
Pattern adapted from mfreedle/honex-platform-mirror/scripts/slack_listener.py.
Install at: /home/connected-carriers/scripts/slack_listener.py
"""

import os
import re
import subprocess
import time
import fcntl
import threading
import logging
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

CHANNEL_ID   = "C0ARKBC5VRA"   # #cc-agent-logs in Connected Carriers workspace
REPO_DIR     = "/home/connected-carriers"
LOCK_FILE    = "/tmp/cc_agent.lock"
STARTUP_TS   = str(time.time())

app = App(
    token=os.environ["SLACK_BOT_TOKEN"],
    signing_secret=os.environ["SLACK_SIGNING_SECRET"],
)

handled_timestamps = set()
_lock_fd = None


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


def post_to_slack(text):
    try:
        app.client.chat_postMessage(channel=CHANNEL_ID, text=text)
    except Exception as e:
        logger.error(f"Failed to post to Slack: {e}")


def fire_headless(directive_text):
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
        logger.info(f"Fired headless_cc_directive.sh with directive: {directive_text[:80]}")
    except Exception as e:
        release_lock()
        post_to_slack(f":x: *CC Agent* — failed to fire headless script: {e}")
        logger.exception("Failed to fire headless script")


@app.event("message")
def handle_message(event, say):
    channel = event.get("channel", "")
    text    = event.get("text", "")
    subtype = event.get("subtype", "")
    ts      = event.get("ts", "")

    # Ignore bot messages, edits, deletes
    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return

    # Only the designated channel
    if channel != CHANNEL_ID:
        return

    # Ignore stale messages from before startup
    if ts and float(ts) < float(STARTUP_TS):
        return

    # Dedup
    if ts in handled_timestamps:
        return
    handled_timestamps.add(ts)

    # Only fire on CC AGENT directives (case-sensitive)
    if not text.strip().startswith("CC AGENT"):
        return

    directive = text[len("CC AGENT"):].strip().lstrip("—").strip()
    if not directive:
        post_to_slack(":warning: Empty directive. Add instructions after CC AGENT.")
        return

    logger.info(f"CC AGENT directive detected: {directive[:80]}")
    threading.Thread(target=fire_headless, args=(directive,), daemon=True).start()


if __name__ == "__main__":
    logger.info(f"Connected Carriers Slack listener starting...")
    logger.info(f"Channel: {CHANNEL_ID}")
    logger.info(f"Repo dir: {REPO_DIR}")
    handler = SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"])
    handler.start()
