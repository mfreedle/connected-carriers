# CC Slack Listener

Connected Carriers Slack Socket Mode listener.

Watches `#cc-agent-logs` for `CC AGENT` directives and fires the headless agent.

## Required Environment Variables (set in Railway)

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Socket Mode App Token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | App signing secret |
| `CC_AGENT_CHANNEL_ID` | Channel ID for #cc-agent-logs |

## Required Slack App Settings

### Bot Token Scopes (OAuth & Permissions)
- `channels:history`
- `channels:read`
- `groups:history` ← required for private channels
- `groups:read` ← required for private channels
- `chat:write`

### Event Subscriptions
- Enable Socket Mode (not HTTP)
- Subscribe to: `message.groups` ← NOT `message.channels` (private channel)

## Usage

Post in `#cc-agent-logs`:
```
CC AGENT — push a new docs/verification_layer.md file documenting the FMCSA lookup flow
```

The agent will acknowledge, execute, push to GitHub, and report results back to the channel.

## Directive Rules (from agent-platform patterns)
- One concern per directive
- Use ALL CAPS for the `CC AGENT` keyword — agents use Title Case in responses
- Include explicit file paths when relevant
- The agent cannot receive follow-up messages mid-run
