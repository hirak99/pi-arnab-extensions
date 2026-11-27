# pi-background-jobs

Focused background shell jobs for Pi. Five tools, durable output, automatic
completion notifications, a session footer, and no agent/provider subsystems.

**Related project:** I’ve used [`pi-background-tasks`](https://pi.dev/packages/pi-background-tasks), and it manages background tasks very well—do take a look, especially if you also need delegated agents, Fusion workflows, attested runs, or Anthropic attribution. This smaller package simply reflects my own preferences: [`pi-subagents`](https://github.com/tintinweb/pi-subagents) already handles agents, I only need run/status/logs/kill/clear here, and every job survives `/reload` by default.

## Features

- `job_run`, `job_status`, `job_logs`, `job_kill`, and `job_clear`
- `/jobs` lists running and recent session jobs; `/jobs clear` permanently
  removes finished jobs and their files
- `/reload` preserves every running job with the same process, PID, output
  streams, start time, and absolute timeout
- Full Pi shutdown stops running jobs; restart preserves history but never
  relaunches commands or adopts persisted PIDs
- POSIX process groups let timeout and kill terminate the whole process tree
- Combined stdout/stderr logs with bounded 50 KB tool reads
- Session-scoped status, logs, and lifecycle operations
- Native completion notifications with Discord Remote support

There are no delegate, Fusion, attestation, attribution, update-check, or
provider-registration features. The initial implementation targets the current
POSIX/Bash environment; Windows process-tree behavior is not verified.

## Install

Install the monorepo and select this extension, or load a local clone directly:

```bash
pi -e /path/to/pi-arnab-extensions/packages/pi-background-jobs/src/index.ts
```

The `job_*` tools, storage, and EventBus channels are distinct from
`pi-background-tasks`. Both packages register `/jobs`; if that command collision
matters during side-by-side use, disable one package's command surface.

## Tools

```text
job_run(name="Docs server", command="npm run docs:dev")
job_run(name="Tests", command="npm test", timeoutSeconds=300)
job_status()
job_status(taskId="<id-or-unique-prefix>")
job_logs(taskId="<id>", tail=true, maxBytes=50000)
job_kill(taskId="<id>")
job_clear(taskId="<id-or-unique-prefix>")
job_clear(allFinished=true)
```

`job_run` uses `/bin/bash -c` with the current directory and environment. It
returns immediately. Completion starts a native follow-up turn; do not poll
`job_status` or `job_logs` merely to wait. Commands run with the user's normal
OS permissions and are not sandboxed.

The footer shows running counts and aggregates unseen completed, failed, and
killed jobs as `N finished`. When running and finished jobs are both present,
the footer combines them as `N of M jobs running`. This presentation is
statusbar-only: `/jobs` and the agent tools retain individual outcomes. `/jobs`
lists the jobs and clears their unseen footer notices. `/jobs clear` and
`job_clear(allFinished=true)` permanently remove all completed, failed, and
killed jobs owned by the current session, including their metadata and output
logs. `job_clear(taskId=...)` removes one finished job. Running jobs are always
untouched: single-job cleanup rejects them with an error and changes nothing.
Deletion is permanent, so failed-job logs should be inspected or deliberately
deemed unnecessary before cleanup. The entire footer item has a blue background
while any job is running and standard text otherwise, including when only failed
jobs remain. Set `NO_COLOR` to disable ANSI styling.

## Lifecycle and storage

Runtime data is stored under `.pi/jobs/<session-id>/` in the launch directory.
Set `PI_JOBS_DIR` to use a different parent directory. Each job has a JSON
metadata file and an `.output` log.

Pi's extension loader replaces modules during `/reload`. This extension leaves
its supervisor at `Symbol.for("pi-background-jobs.supervisor")` on `globalThis`;
the fresh module adopts it and rebinds only notification/UI callbacks. The
actual `ChildProcess` handles and streams remain alive. If a job finishes during
the handoff, its completion is delivered once after rebinding.

A full shutdown sends SIGTERM and then SIGKILL after a grace period. Terminal
metadata is saved after output closes. Cold restore never signals or adopts an
old PID. If Pi crashed while a job was running, its historical record is marked
as not adopted rather than accidentally relaunched.

## Discord Remote

Discord Remote understands this package's `background-job-finished` custom
notification and its display-only `pi-background-jobs:*:v1` status API. Running
jobs participate in Discord's unified activity summary, and terminal jobs use
the same concise, deduplicated messages as `pi-background-tasks`, including
when echo is disabled.

## Development

```bash
npm run check --workspace=pi-background-jobs
```

## License

[Apache License 2.0](LICENSE)
