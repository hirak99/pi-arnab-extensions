# pi-watch

Durable watches for Pi agents. Register a command once; get an inbox
notification when it has something to say — zero tokens while nothing
happens.

Two modes, one contract each:

- **`watch_create_poll(name, run, every_seconds=60)`** — the command is a
  *check*. It runs every `every_seconds` (minimum 15s) and must exit quickly:
  exit 0 = silence, exit 1 = one notification with the command's combined
  output, any other exit/signal/timeout = a "broke" notification (once per
  breakage) and a "recovered" notification when checks succeed again.
- **`watch_create_stream(name, run, match?, on_finish?)`** — the command is a
  *listener*. It starts once and runs long; each non-empty stdout line
  matching `match` (a regular expression; default: every non-empty line) is
  one notification with the line as its message. Only stdout can notify;
  stderr is captured to the watch log. A clean exit is silent
  (`on_finish=true` requests one "finished" notification); any other exit is
  reported as "broke" and the script restarts with backoff.

Shared lifecycle and observability:

- `watch_list`, `watch_inspect`, `watch_pause`, `watch_resume`, `watch_remove`
- `watch_tail(name, lines=50)` — the full captured output with
  `[stdout]:` / `[stderr]:` prefixes and a synthesized `[status]:` trailer
  ("script is still running", "script exited with code N", "watch is paused",
  restart scheduling).

Semantics:

- Deliveries are rate-limited (15s floor per watch plus a short grace window
  so bursts coalesce); a rate-limited notification shows the last 3 event
  lines and a "N notifications before this not shown; use watch_tail"
  trailer. The full stream is always in the log.
- Scripts get a private state directory in `$WATCH_STATE` (plus `WATCH_ID`,
  `WATCH_NAME`, `WATCH_MODE`). Keep cursors there so restarts do not
  re-notify.
- Definitions persist on disk under `~/.pi/pi-watch/` (override with
  `PI_WATCH_DIR`); running processes do not survive a Pi restart (v1).
  Notifications are delivered through the `pi-durable-inbox` outbox: durable,
  draft-safe, and queued for session startup.

Docs and usage examples (periodic wakeup, file-change notifier, GitHub issue
watcher) ship in the tool descriptions and guidelines.

## Development

```bash
npm run check --workspace=pi-watch
```
