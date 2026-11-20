# pi-arnab-extensions

A local-first monorepo for reviewed Pi extensions maintained by Arnab and the
DevOps Agent.

## Packages

| Package | Directory | Origin |
| --- | --- | --- |
| Discord Remote | `packages/discord-remote` | Full history imported from `~/git/pi-discord-remote` |
| Agentic Team | `packages/agentic-team` | Full history imported from `~/git/pi-agentic-team` |

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
