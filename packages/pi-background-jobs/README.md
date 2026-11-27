# pi-background-jobs

Focused background shell jobs for Pi. Four tools, durable output, automatic
completion notifications, a session footer, and no agent/provider subsystems.

## Features

- `job_run`, `job_status`, `job_logs`, and `job_kill`
- `/job` lists running and recent session jobs (`/job <id>` inspects one)
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

It can run alongside `pi-background-tasks`: tool names, storage, and EventBus
channels are distinct. The other package already owns `/jobs`, so this package
uses `/job`.

## Tools

```text
job_run(name="Docs server", command="npm run docs:dev")
job_run(name="Tests", command="npm test", timeoutSeconds=300)
job_status()
job_status(taskId="<id-or-unique-prefix>")
job_logs(taskId="<id>", tail=true, maxBytes=50000)
job_kill(taskId="<id>")
```

`job_run` uses `/bin/bash -c` with the current directory and environment. It
returns immediately. Completion starts a native follow-up turn; do not poll
`job_status` or `job_logs` merely to wait. Commands run with the user's normal
OS permissions and are not sandboxed.

The footer shows running counts and unseen terminal results. `/job` lists the
jobs and clears their unseen footer notices.

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
