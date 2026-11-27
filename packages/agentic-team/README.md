# pi-agentic-team

A Pi extension for filesystem-backed team registration, optional team
memberships, direct messages, and durable broadcasts.

**Status:** early MVP. Files are the durable protocol. An in-process inbox
watcher delivers direct and broadcast messages through Pi's native messaging API.

## Features

- Persistent team agent UUIDs, independent of Pi session IDs
- Optional multi-team membership; agents may remain unassigned
- Per-process instance UUIDs for safe lifecycle updates
- `/team-agent-register` command and agent-initiated registration tool
- `/team-agent-responsibilities` command for the current session
- Self-UUID and full self-registration tools
- Agent discovery with live/stale status
- Safe member deletion by archival, preserving message history
- Direct inboxes with durable Markdown messages and automatic read receipts
- Durable broadcasts to selected teams or all active agents, with recipient deduplication
- Inline-by-default native delivery, with reference delivery for sensitive content
- Direct delivery never writes to or submits the interactive editor buffer
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
team_register(duties="...", teams=["dev", "ops"])  # optional multi-team membership
```

The tool returns only the generated team agent UUID needed for routing.
Registration captures the Pi session ID, CWD, process ID, and tmux pane when
available. Tmux is used only for pane liveness checks, never for message input.
The registration identity is persisted in the Pi session, so a clean reload or
resume restores the same team UUID with a fresh instance UUID. `teams` is
optional: omitting it leaves a new agent unassigned and preserves existing
memberships during re-registration. Passing an explicit list replaces all
memberships, and `teams=[]` clears them.

## Update current responsibilities

```text
/team-agent-responsibilities Review changes, run tests, and report regressions.
```

This updates the current registered session only. The registry stores a revision
and update timestamp, and the command sends the revised responsibilities to the
running agent as a custom notification. Agents can inspect their own
responsibilities with `team_get_self()` and other agents' responsibilities with
`team_list_agents()`.

A session outside tmux can still register and receive native inbox delivery.
Without a tmux pane, liveness relies on the registered process ID.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `team_register` | Register or reactivate the current session; optionally replace team memberships |
| `team_get_self_uuid` | Return this agent's persistent team UUID |
| `team_get_self` | Return focused identity, role, instance, and liveness information |
| `team_list_agents` | Discover agents through focused role/team/liveness summaries; optionally include inactive/archived entries |
| `team_send_message` | Persist a direct message and deliver a steering/idle-wakeup notification |
| `team_broadcast` | Deliver durable direct messages to selected team members or all active agents |
| `team_reply` | Reply to a direct message with automatic recipient resolution and `reply_to` threading |
| `team_read_messages` | Read the current direct inbox, including broadcasts; inbox reads record receipts |
| `team_message_status` | Optionally check the read status of a message sent by this agent |
| `team_delete_member` | Archive a registration without deleting message history |

### Direct messages

A sender calls `team_send_message` with the recipient's team UUID and text. The
extension first verifies that the recipient is active and live, then writes the
message atomically and returns `wake_status: "queued"`. The recipient's
in-process inbox watcher uses a visible custom `pi.sendMessage()` notification
with a `[team]` renderer; it never enters Pi's user-input path or modifies the
interactive editor. If the agent is busy, the notification steers the active
turn immediately. If the agent is idle, Pi starts a new turn. Unread
messages are also delivered when a registered session starts.

Delivery defaults to `inline`, so the native message includes the sender UUID,
message UUID, and complete body:

```text
Team message from Sender (<sender-uuid>), message <message-uuid>:

Please review the PR and reply when it is merged.
```

The recipient can process the message immediately. When a response is requested
or useful, it calls `team_reply` with the incoming message UUID as `reply_to`;
the tool validates that the original was a direct message addressed to this
agent, resolves the original sender automatically, and preserves threading:

```text
team_reply(reply_to="<message-uuid>", text="Review complete")
```

A normal assistant response is not delivered to the originating agent. No
acknowledgment is required merely because a message was received or read.
Watch notifications are not direct-reply requests.

Reply notifications include `in reply to <message-uuid>` when threaded. Both
`team_send_message` and `team_reply` default to `delivery="inline"`; either
can use `delivery="reference"` for sensitive content. The native reference
message contains only sender/message/thread metadata, and the recipient uses
`team_read_messages(message_id=...)` to retrieve the body.

Inline messages record a read receipt when the receiving extension sends the
custom notification. Reference messages record one when the recipient reads
the inbox. The sender can optionally inspect
`team_message_status(message_id=...)`; receipts do not wake the sender or start
another model turn. The message file remains the
durable record if native delivery fails; the recipient reports watcher errors in
its Pi UI.

### Broadcasts and team membership

`team_broadcast` creates one ordinary direct inbox message per selected active,
live recipient. Omitting `teams` selects all active agents, including unassigned
agents. Supplying one or more team slugs selects their union and deduplicates
agents belonging to multiple teams. The sender is always excluded; inactive or
stale agents are skipped and counted in the result. An explicit empty team list
is rejected to prevent an accidental all-agent broadcast.

```text
team_broadcast(teams=["dev", "ops"], text="Please review the deployment plan")
team_broadcast(text="Status check for every active agent")
```

Each recipient gets an independent durable message ID and normal read receipt;
all messages share one `broadcast_id`. The result reports recipient, inactive,
and failed counts plus per-recipient delivery IDs for `team_message_status`.
Inline and reference delivery work exactly as for direct messages. Recipients
reply to the sender with `team_reply`; no automatic acknowledgments or
broadcast-reply storms are generated.

### Deleting a member

Inactive members can be deleted directly. Deleting an active member requires
`confirm=true`. Deletion:

- Moves the registration to `agents/archived/`
- Clears its transport
- Preserves all inbox history
- Does not terminate the member's Pi process

## Storage layout

```text
team/
├── agents/
│   ├── <agent-uuid>.json
│   └── archived/
│       └── <agent-uuid>.json
└── inboxes/
    └── <agent-uuid>/
        ├── <message-uuid>.md
        └── <message-uuid>.md.read.json
```

Messages are Markdown files with YAML-compatible frontmatter. Legacy
`comm_channels/` files are left untouched for forensics; the extension no longer
reads or writes them.

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
- Broadcast delivery is best-effort per recipient; partial failures are reported
- No heartbeat writer; liveness is checked on demand
- No remote hosts or cross-machine transport
- Registry and messages are trusted local files, not an authentication boundary
- Agent messages do not grant additional permissions or deployment authority

## License

[Apache License 2.0](LICENSE)
