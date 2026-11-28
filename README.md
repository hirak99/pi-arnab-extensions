# pi-arnab-extensions

A local-first monorepo for Pi extensions managed by Arnab and the DevOps
Agent. Some packages are original projects; others are heavily modified forks.
Each package retains its own authorship, attribution, and license.

## Packages

| Package | Directory | Origin and license |
| --- | --- | --- |
| Discord Remote | `packages/discord-remote` | Heavily modified fork of [Chuan Bai's `pi-discord-remote`](https://github.com/t2o2/pi-discord-remote); MIT |
| Agentic Team | `packages/agentic-team` | Original project; Apache-2.0 |
| Watch | `packages/pi-watch` | Original project; Apache-2.0 |
| Background Jobs | `packages/pi-background-jobs` | Original project; Apache-2.0 |
| Durable Inbox | `packages/durable-inbox` | Original project; Apache-2.0 (library package, not a Pi extension) |
| Output Store | `packages/pi-output-store` | Original project; Apache-2.0 (library package, not a Pi extension) |

## Licensing

Apache-2.0 is the default license for original monorepo content. A package's
own `LICENSE` takes precedence. Discord Remote remains MIT. Agentic Team,
Watch, Background Jobs, Durable Inbox, and Output Store are original projects and each keeps an identical
Apache-2.0 license copy for standalone package distribution.

The original repositories remain unchanged. This monorepo's own upstream is
`origin` (`https://github.com/hirak99/pi-arnab-extensions`).

## Git installation

Install all declared extensions directly from the upstream repository:

```bash
pi install git:github.com/hirak99/pi-arnab-extensions@main
```

## Local installation

Load all declared extensions:

```bash
pi install /home/arnab/git/pi-arnab-extensions
```

Select only Agentic Team in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "/home/arnab/git/pi-arnab-extensions",
      "extensions": ["packages/agentic-team/src/index.ts"]
    }
  ]
}
```

Resource filters can similarly select the Discord Remote `dist` entry. Review
and test changes before enabling extensions; extensions execute with Pi's OS
permissions.

## Development

```bash
npm install
npm run build
npm run check
```

Each package retains its own documentation, license, tests, and package
metadata. Use explicit Git author/committer identity for new commits.
