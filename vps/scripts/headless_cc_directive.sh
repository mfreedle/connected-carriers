#!/usr/bin/env bash
# Connected Carriers headless agent runner
# Install at: /home/connected-carriers/scripts/headless_cc_directive.sh
set -uo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: Must run as claude-agent, not root." >&2; exit 1
fi

export HOME=/home/claude-agent
export PATH="/home/claude-agent/.local/bin:$PATH"
set +e; set -a
source /home/connected-carriers/.env 2>/dev/null
set +a; set -e
eval "$(~/.local/bin/mise activate bash)" 2>/dev/null || true

CHANNEL_ID="C0ARDH1B86S"
LOG_DIR="/home/connected-carriers/logs"
mkdir -p "$LOG_DIR"

_cleanup() { [ -n "${SSH_AGENT_PID:-}" ] && kill "$SSH_AGENT_PID" 2>/dev/null || true; }
trap '_cleanup' EXIT

DIRECTIVE_TEXT="${DIRECTIVE_TEXT:-}"

if [ -z "$DIRECTIVE_TEXT" ]; then
  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$CHANNEL_ID\",\"text\":\":rotating_light: *Cc Agent ABORT* - directive was empty.\"}" > /dev/null 2>&1
  exit 0
fi

PROMPT="You are the CC Agent for Connected Carriers (github.com/mfreedle/connected-carriers).
Execute this directive: ${DIRECTIVE_TEXT}
Rules:
- Push changes via GitHub API with token ${GITHUB_TOKEN}
- PUT to https://api.github.com/repos/mfreedle/connected-carriers/contents/{path}
- Always GET current SHA before updating existing files
- Base64 encode content and strip newlines before pushing
- Follow all rules in .claude/CLAUDE.md
- Post results to #cc-agent-logs (C0ARKBC5VRA) using the Slack tool
- Use title case in Slack posts, never ALL CAPS"

OUTPUT_FILE=$(mktemp /tmp/cc_directive_output.XXXXXX)
set +e
timeout 3600 claude -p "$PROMPT" \
  --allowedTools "Read,Edit,Write,Bash,Grep,Glob,mcp__claude_ai_Slack__slack_send_message,mcp__claude_ai_Slack__slack_read_channel" \
  --dangerously-skip-permissions 2>&1 | tee "$OUTPUT_FILE" >> "$LOG_DIR/headless_cc.log"
CLAUDE_EXIT=${PIPESTATUS[0]}
set -e

if [ "$CLAUDE_EXIT" -ne 0 ]; then
  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$CHANNEL_ID\",\"text\":\":rotating_light: *Cc Agent FAILED* (exit $CLAUDE_EXIT)\"}" > /dev/null 2>&1
fi

rm -f /tmp/cc_agent.lock "$OUTPUT_FILE"
exit "$CLAUDE_EXIT"
