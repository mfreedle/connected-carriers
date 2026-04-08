#!/usr/bin/env bash
# Run as root on 137.184.36.72
set -euo pipefail
CC_DIR="/home/connected-carriers"
mkdir -p "$CC_DIR/scripts" "$CC_DIR/logs"
sudo -u claude-agent /home/claude-agent/.local/bin/pip install slack-bolt slack-sdk --quiet
cp "$(dirname $0)/scripts/slack_listener.py" "$CC_DIR/scripts/"
cp "$(dirname $0)/scripts/headless_cc_directive.sh" "$CC_DIR/scripts/"
chmod +x "$CC_DIR/scripts/headless_cc_directive.sh" "$CC_DIR/scripts/slack_listener.py"
chown -R claude-agent:claude-agent "$CC_DIR"
if [ ! -f "$CC_DIR/.env" ]; then
  cat > "$CC_DIR/.env" << 'ENVEOF'
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_SIGNING_SECRET=
CC_AGENT_CHANNEL_ID=C0ARKBC5VRA
GITHUB_TOKEN=
ENVEOF
  chown claude-agent:claude-agent "$CC_DIR/.env"
  chmod 600 "$CC_DIR/.env"
fi
cp "$(dirname $0)/cc_slack_listener.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable cc_slack_listener
echo "Done. Fill in /home/connected-carriers/.env then: systemctl start cc_slack_listener"
