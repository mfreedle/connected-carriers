#!/usr/bin/env bash
# Run as root on 137.184.36.72
# Usage: cd /tmp && git clone https://TOKEN@github.com/mfreedle/connected-carriers.git cc-setup && bash cc-setup/vps/install.sh
set -euo pipefail

CC_DIR="/home/connected-carriers"
mkdir -p "$CC_DIR/scripts" "$CC_DIR/logs"

# Install Python dependencies — try multiple pip locations
echo "Installing Python deps..."
PIP=""
for p in pip3 pip /usr/bin/pip3 /usr/local/bin/pip3; do
  if command -v "$p" &>/dev/null; then PIP="$p"; break; fi
done
if [ -z "$PIP" ]; then
  apt-get install -y python3-pip -q
  PIP="pip3"
fi
$PIP install slack-bolt slack-sdk --quiet

# Copy scripts
echo "Copying scripts..."
cp "$(dirname $0)/scripts/slack_listener.py" "$CC_DIR/scripts/"
cp "$(dirname $0)/scripts/headless_cc_directive.sh" "$CC_DIR/scripts/"
chmod +x "$CC_DIR/scripts/headless_cc_directive.sh" "$CC_DIR/scripts/slack_listener.py"
chown -R claude-agent:claude-agent "$CC_DIR"

# Create .env if not exists
if [ ! -f "$CC_DIR/.env" ]; then
  printf 'SLACK_BOT_TOKEN=\nSLACK_APP_TOKEN=\nSLACK_SIGNING_SECRET=\nCC_AGENT_CHANNEL_ID=C0ARKBC5VRA\nGITHUB_TOKEN=\n' > "$CC_DIR/.env"
  chown claude-agent:claude-agent "$CC_DIR/.env"
  chmod 600 "$CC_DIR/.env"
fi

# Install systemd service
echo "Installing systemd service..."
cp "$(dirname $0)/cc_slack_listener.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable cc_slack_listener

echo ""
echo "Install complete."
echo "Next: nano /home/connected-carriers/.env — add your Slack tokens"
echo "Then: systemctl start cc_slack_listener && systemctl status cc_slack_listener"
