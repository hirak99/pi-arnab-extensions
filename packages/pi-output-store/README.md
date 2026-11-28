# pi-output-store

Library-only output storage shared by Watch and Background Jobs. It is not a Pi
extension.

- Uses `${os.tmpdir()}/pi-<username>/` with private per-user directories.
- Preserves a fixed current output path and at most one `.1` rotated segment.
- Rotates by bytes (10 MiB per segment by default) without terminating the
  producer, and serializes writes so callers can apply stream backpressure.
- Persists cumulative omitted-line accounting in a small temporary sidecar.
- Reads recent output across both segments, tolerates missing temporary files,
  and deletes current, rotated, and accounting artifacts together.
- Atomically exports a consistent snapshot of every retained byte across both
  segments, with explicit overwrite control and no inspection-size cap.

See `src/index.ts` for the API and package tests for lifecycle examples.

## Development

```bash
npm run check --workspace=pi-output-store
```

## License

Apache-2.0; see `LICENSE`.
