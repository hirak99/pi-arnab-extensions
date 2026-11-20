# pi-agentic-team

A Pi extension for filesystem-backed team registration, direct messages, and
Slack-like asynchronous channels.

**Status:** early MVP. Files are the durable protocol. An in-process inbox
watcher delivers direct messages through Pi's native messaging API; channel
messages are read on demand.

## Features

- Persistent team agent UUIDs, independent of Pi session IDs
- Per-process instance UUIDs for safe lifecycle updates
- `/team-agent-register` command and agent-initiated registration tool
- `/team-agent-responsibilities` command for the current session
- Self-UUID and full self-registration tools
- Agent discovery with live/stale status
- Safe member deletion by archival, preserving message history
- Direct inboxes with durable Markdown messages and automatic read receipts
- Inline-by-default native delivery, with reference delivery for sensitive content
- Direct delivery never writes to or submits the interactive editor buffer
- Asynchronous channel messages using one file per message
- Atomic file writes and cross-process registry locks

## Installation

Install from GitHub:

```bash
pi install git:github.com/hirak99/pi-agentic-team
```

To pin the `main` branch explicitly:

```bash
pi install git:github.com/hirak99/pi-agentic-team@main
```

Or install a local clone:

```bash
pi install /path/to/pi-agentic-team
```

Try the extension for one invocation without installing:

```bash
pi -e /path/to/pi-agentic-team
```

Review and trust the source before installation. Like every Pi extension, it runs
with the same operating-system permissions as Pi.

By default, team state is stored in:

```text
~/.pi/agentic-team/
```

Set `PI_TEAM_DIR` when launching Pi to use a different shared directory. All
agents on a team must use the same directory.

## Register the current session

As the human:

```text
/team-agent-register Review repository changes and run the test suite.
```

Or ask the current agent to register itself. It can call:

```text
team_register(duties="...", name="optional-name")
```

Registration captures the Pi session ID, CWD, process ID, and tmux pane when
available. Tmux is used only for pane liveness checks, never for message input.
The registration identity is persisted in the Pi session, so a clean reload or
resume restores the same team UUID with a fresh instance UUID.

## Update current responsibilities

```text
/team-agent-responsibilities Review changes, run tests, and report regressions.
```

This updates the current registered session only. The registry stores a revision
and update timestamp, and the command sends the revised responsibilities to the
running agent as a user message or follow-up. Agents can inspect their own
responsibilities with `team_get_self()` and other agents' responsibilities with
`team_list_agents()`.

A session outside tmux can still register and receive native inbox delivery.
Without a tmux pane, liveness relies on the registered process ID.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `team_register` | Register or reactivate the current session |
| `team_get_self_uuid` | Return this agent's persistent team UUID |
| `team_get_self` | Return full identity, registration, transport, and liveness |
| `team_list_agents` | Discover active agents; optionally include inactive/archived entries |
| `team_send_message` | Persist a direct message and queue native recipient delivery |
| `team_read_messages` | Read the current inbox or channel history; inbox reads record receipts |
| `team_message_status` | Optionally check the read status of a message sent by this agent |
| `team_post_channel` | Post an asynchronous channel message |
| `team_delete_member` | Archive a registration without deleting message history |

### Direct messages

A sender calls `team_send_message` with the recipient's team UUID and text. The
extension first verifies that the recipient is active and live, then writes the
message atomically and returns `wake_status: "queued"`. The recipient's
in-process inbox watcher uses `pi.sendUserMessage()`; it never pastes into or
presses Enter in the interactive editor, so an unfinished human draft is left
untouched. If the agent is busy, Pi queues the message as a follow-up. Unread
messages are also delivered when a registered session starts.

Delivery defaults to `inline`, so the native message includes the sender UUID,
message UUID, and complete body:

```text
Team message from Sender (<sender-uuid>), message <message-uuid>:

Please review the PR and reply when it is merged.
```

The recipient can process the message immediately and respond with a normal
`team_send_message` when requested. No separate acknowledgement is required.

For sensitive content, use `delivery="reference"`. The native message then
contains only sender and message metadata; the recipient uses
`team_read_messages(message_id=...)` to retrieve the body.

Inline messages record a read receipt when the receiving extension accepts the
input. Reference messages record one when the recipient reads the inbox. The
sender can optionally inspect `team_message_status(message_id=...)`; receipts do
not wake the sender or start another model turn. The message file remains the
durable record if native delivery fails; the recipient reports watcher errors in
its Pi UI.

### Channels

Use lowercase channel slugs containing letters, digits, hyphens, or underscores:

```text
team_post_channel(channel="engineering", text="Status update")
team_read_messages(channel="engineering", limit=20)
```

Channels do not wake subscribers in this MVP. This avoids waking every agent for
every message and creating unintended model usage or feedback loops.

### Deleting a member

Inactive members can be deleted directly. Deleting an active member requires
`confirm=true`. Deletion:

- Moves the registration to `agents/archived/`
- Clears its transport
- Preserves channel history
- Preserves the inbox
- Does not terminate the member's Pi process

## Storage layout

```text
team/
├── agents/
│   ├── <agent-uuid>.json
│   └── archived/
│       └── <agent-uuid>.json
├── inboxes/
│   └── <agent-uuid>/
│       ├── <message-uuid>.md
│       └── <message-uuid>.md.read.json
└── comm_channels/
    └── <channel-name>/
        └── YYYY/MM/DD/
            └── <timestamp>_<message-uuid>.md
```

Messages are Markdown files with YAML-compatible frontmatter. Channel filenames
include UTC timestamps and UUIDs to avoid same-second collisions.

Shutdown deactivation is compare-and-swap on both agent UUID and instance UUID,
so an old process cannot deactivate a newer instance. Clean shutdown is covered
by Pi's `session_shutdown` lifecycle event; crashes are reported as stale by
liveness checks.

## Development

Requirements: Node.js 22 or later and npm. Tmux is optional and used only for
pane liveness checks.

```bash
npm install
npm run check
```

The checks run strict TypeScript checking and Node's built-in test runner.
Extensions are loaded through Pi's TypeScript runtime, so no build step is
required.

## Current limitations

- Native inbox delivery requires the recipient's registered Pi process to be running
- No channel subscriptions, mentions, or automatic channel wake-ups
- No heartbeat writer; liveness is checked on demand
- No remote hosts or cross-machine transport
- Registry and messages are trusted local files, not an authentication boundary
- Agent messages do not grant additional permissions or deployment authority

## License

[Apache License 2.0](LICENSE)
