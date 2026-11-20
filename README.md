# pi-arnab-extensions

A local-first monorepo for Pi extensions managed by Arnab and the DevOps
Agent. Some packages are original projects; others are heavily modified forks.
Each package retains its own authorship, attribution, and license.

## Packages

| Package | Directory | Origin and license |
| --- | --- | --- |
| Discord Remote | `packages/discord-remote` | Heavily modified fork of [Chuan Bai's `pi-discord-remote`](https://github.com/t2o2/pi-discord-remote); MIT |
| Agentic Team | `packages/agentic-team` | Original project; Apache-2.0 |

## Licensing

Apache-2.0 is the default license for original monorepo content. A package's
own `LICENSE` takes precedence. Discord Remote remains MIT. Agentic Team keeps
an identical Apache-2.0 license copy for standalone package distribution.

The original repositories remain unchanged. This monorepo has no remote until
one is explicitly configured.

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
