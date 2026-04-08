# CC Slack Listener

Connected Carriers Slack Socket Mode listener.
Watches `#cc-agent-logs` (C0ARKBC5VRA) for `CC AGENT` directives and fires the headless agent.

## Required Environment Variables (set in Railway on cc-slack-listener service)

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Socket Mode App Token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | App signing secret |
| `CC_AGENT_CHANNEL_ID` | `C0ARKBC5VRA` (#cc-agent-logs in Connected Carriers workspace) |

## Required Slack App Settings (CC Agent Dispatcher)

### Bot Token Scopes (OAuth & Permissions)
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `chat:write`

### Socket Mode
- Enable Socket Mode ON
- App-Level Token name: `cc-socket-token`

### Event Subscriptions
- Subscribe to bot events: `message.groups` (NOT message.channels — private channel)

## Usage

Post in `#cc-agent-logs`:
```
CC AGENT — push a new docs/verification_layer.md documenting the FMCSA lookup flow
```

The agent will acknowledge, execute, push to GitHub, and report results back.

## Directive Rules
- One concern per directive
- Use ALL CAPS for `CC AGENT` keyword
- Include explicit file paths when relevant
- Agent cannot receive follow-up messages mid-run
