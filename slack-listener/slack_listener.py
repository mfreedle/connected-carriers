#!/usr/bin/env python3
"""
Connected Carriers Slack Socket Mode Listener.
Watches #cc-agent-logs for CC AGENT directives.
Uses Anthropic API directly — no Claude CLI needed.
"""

import os
import threading
import logging
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
import anthropic

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SLACK_BOT_TOKEN      = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN      = os.environ["SLACK_APP_TOKEN"]
SLACK_SIGNING_SECRET = os.environ["SLACK_SIGNING_SECRET"]
ANTHROPIC_API_KEY    = os.environ["ANTHROPIC_API_KEY"]
CC_AGENT_CHANNEL_ID  = os.environ.get("CC_AGENT_CHANNEL_ID", "")
GITHUB_TOKEN         = os.environ.get("GITHUB_TOKEN", "")

AGENT_KEYWORD = "CC AGENT"

app = App(token=SLACK_BOT_TOKEN, signing_secret=SLACK_SIGNING_SECRET)
ai  = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

def post(channel, text):
    try:
        app.client.chat_postMessage(channel=channel, text=text)
    except Exception as e:
        log.error(f"Slack post failed: {e}")

def run_agent(directive, channel_id):
    try:
        post(channel_id, ":robot_face: *CC Agent* — working...")

        system = f"""You are the CC Agent for Connected Carriers (github.com/mfreedle/connected-carriers).
Execute the directive. Push changes to GitHub using:
- Token: {GITHUB_TOKEN}
- PUT to: https://api.github.com/repos/mfreedle/connected-carriers/contents/PATH
- Always GET current SHA before updating files. Base64 encode content.
Report what you did in 3-5 sentences."""

        resp = ai.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": directive}]
        )

        result = resp.content[0].text if resp.content else "No response"
        post(channel_id, f":white_check_mark: *CC Agent Done*
{result}")

    except Exception as e:
        post(channel_id, f":x: *CC Agent Error*
```{str(e)}```")
        log.exception("Agent error")

@app.event("message")
def handle_message(event, say):
    channel = event.get("channel", "")
    text    = event.get("text", "")
    subtype = event.get("subtype", "")

    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return
    if CC_AGENT_CHANNEL_ID and channel != CC_AGENT_CHANNEL_ID:
        return
    if not text.strip().startswith(AGENT_KEYWORD):
        return

    directive = text[len(AGENT_KEYWORD):].strip()
    if not directive:
        post(channel, ":warning: Empty directive. Add instructions after CC AGENT.")
        return

    log.info(f"Directive: {directive[:80]}")
    threading.Thread(target=run_agent, args=(directive, channel), daemon=True).start()

if __name__ == "__main__":
    log.info(f"CC Slack listener starting — channel: {CC_AGENT_CHANNEL_ID}")
    SocketModeHandler(app, SLACK_APP_TOKEN).start()
