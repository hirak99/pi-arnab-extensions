# pi-durable-inbox

Filesystem-backed durable messaging for Pi extension packages. Library only —
not a Pi extension and not loadable by Pi; consumed by extension packages
such as `pi-agentic-team` and `pi-watch`.

Provides:

- `MessageStore`: one file per direct message, atomic writes, no database.
  Direct inboxes live at `inboxes/<recipient>/<id>.md`. Identity validation
  is the consumer's concern; the store enforces body limits and read semantics.
  Direct messages may carry an optional shared broadcast ID and audience-team metadata without changing
  their per-recipient identity or read-receipt behavior.
- `InboxDelivery`: watches a recipient's inbox and delivers unread messages
  through a caller-supplied native sender, never via terminal or user-input
  injection. Delivery format and sender identity are consumer hooks, so
  different packages keep different semantics over the same proven mechanics:
  deduplicated, offline-queued and delivered on startup.
- `sendNativeNotification`: sends a visible custom Pi message with a
  package-specific renderer, always using `deliverAs="steer"` and
  `triggerTurn=true`. Pi steers an active run and starts a new run when idle.
  Neither path uses `pi.sendUserMessage` or modifies the interactive editor.

## Development

```bash
npm run check --workspace=pi-durable-inbox
```
