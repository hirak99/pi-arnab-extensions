# pi-watch

Durable watches for Pi agents. Register a command once; get an inbox
notification when it has something to say — zero tokens while nothing
happens.

Two modes, one contract each:

- **`watch_create_poll(name, run, every_seconds=60, max_events?)`** — the command is a
  *check*. It runs every `every_seconds` (minimum 15s) and must exit quickly:
  exit 0 = silence, exit 1 = one notification with the command's combined
  output, any other exit/signal/timeout = a "broke" notification (once per
  breakage) and a "recovered" notification when checks succeed again.
- **`watch_create_stream(name, run, match?, on_finish?, max_events?)`** — the command is a
  *listener*. It starts once and runs long; each non-empty stdout line
  matching `match` (a regular expression; default: every non-empty line) is
  one notification with the line as its message. Only stdout can notify;
  stderr is captured to the watch log. A clean exit is silent
  (`on_finish=true` requests one "finished" notification); any other exit is
  reported as "broke" and the script restarts with backoff.

Shared lifecycle and observability:

- `watch_list`, `watch_inspect`, `watch_pause`, `watch_resume`, `watch_remove`
  operate only on watches owned by the current Pi session. Watch names must be
  unique within a session; different sessions may reuse the same name.
- `watch_tail(name, lines=50)` — the full captured output with
  `[stdout]:` / `[stderr]:` prefixes and a synthesized `[status]:` trailer
  ("script is still running", "script exited with code N", "watch is paused",
  restart scheduling).

Semantics:

- Watches are best suited for recurring alerts or continuous monitoring. If a
  one-shot background/completion mechanism is available, prefer it for strictly
  one-time work. For a one-shot watch alert, set `max_events=1` explicitly.
- `max_events` is an optional lifetime cap on source alert events: exit-1 poll
  alerts or matching stream stdout lines, not coalesced deliveries. Reaching it
  flushes the final notification batch and automatically removes the watch
  without an extra `on_finish` notice. Logs and script state remain on disk for
  forensics. Pause/resume does not reset the budget; create a new watch after
  automatic removal to re-arm.
- Notifications are visible custom Pi messages with a compact `[watch]`
  renderer. Active runs are steered immediately; Pi starts a new run when the
  session is idle. Delivery never enters the user-input path or modifies an
  unfinished editor draft.
- Deliveries are rate-limited (15s floor per watch plus a short grace window
  so bursts coalesce); a rate-limited notification shows the last 3 event
  lines and a "N notifications before this not shown; use watch_tail"
  trailer. The full stream is always in the log.
- Scripts get a private state directory in `$WATCH_STATE` (plus `WATCH_ID`,
  `WATCH_NAME`, `WATCH_MODE`). Watch commands must be idempotent; keep cursors
  in `$WATCH_STATE` so restarts do not re-notify old events. Full restart
  relaunches stream commands; checkpoint time-sensitive progress there.
- The Pi footer shows `👀 N/M watchers active` for the current session, with a
  `· X broken` suffix only when needed. The status item is hidden entirely when
  the session has no watches.
- Definitions persist on disk under `~/.pi/pi-watch/` (override with
  `PI_WATCH_DIR`) and remain bound to their owning session ID. Running watches
  survive `/reload` without a process stop/start cycle. On a full Pi shutdown
  their scripts stop, and resuming the exact owning session automatically
  starts them again while preserving any remaining scheduled delay; overdue
  checks run immediately. Paused, explicitly stopped, and cleanly completed
  watches remain inactive. `watch_resume` remains available for manual re-arming.
  A new session, including one started in the same directory, neither lists nor
  auto-resumes a previous session's watches. Notifications are delivered
  through the `pi-durable-inbox` outbox: durable, deduplicated, and queued for
  session startup.

Docs and usage examples (periodic wakeup, file-change notifier, GitHub issue
watcher) ship in the tool descriptions and guidelines.

## Process durability design

**Maintainer design decision:** do not use `nohup` or otherwise try to keep
watch processes alive across a Pi restart. Treat every full Pi restart as if it
were a full system restart: recovery must work when every old process is gone.
Persist only definitions, running intent, schedules, and `$WATCH_STATE`, then
create fresh processes on exact-session resume. The sole process-preserving
path is an in-process `/reload` supervisor handoff. Changing this design
requires Arnab's explicit authorization.

## Development

```bash
npm run check --workspace=pi-watch
```
