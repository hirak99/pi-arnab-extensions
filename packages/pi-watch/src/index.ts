import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { InboxDelivery, MessageStore } from "pi-durable-inbox";

import { senderIdentity, statusLine } from "./format.ts";
import { WatchRegistry } from "./registry.ts";
import { WatchSupervisor, WatchError } from "./supervisor.ts";
import {
	DEFAULT_EVERY_SECONDS,
	DEFAULT_TIMEOUT_SECONDS,
	MIN_EVERY_SECONDS,
	type WatchDefinition,
} from "./types.ts";

const TOOL_NAMES = [
	"watch_create_poll",
	"watch_create_stream",
	"watch_list",
	"watch_inspect",
	"watch_pause",
	"watch_resume",
	"watch_remove",
	"watch_tail",
] as const;

function toolResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

function toWatchError(error: unknown): never {
	if (error instanceof WatchError) throw new Error(error.message);
	throw error;
}

const DECISION_RULE =
	"If the command finishes quickly and answers \"did it happen? yes/no\", use watch_create_poll (the exit code speaks: 0 = silence, non-zero = notification with its output). " +
	"If the command runs continuously and announces things as they happen, use watch_create_stream (each stdout line speaks; only stdout can notify, stderr is captured to the watch log). " +
	"Watches are durable and persistent: they keep running and delivering events until watch_remove.";

const POLL_EXAMPLE = [
	"Examples:",
	"- Periodic wakeup every hour: watch_create_poll(name=\"tick\", every_seconds=3600, run=\"false\") (\"false\" exits non-zero every run, so one notification per hour).",
	"- Watch a GitHub issue for new replies:",
	"  run: \"latest=$(gh issue view 157 --repo hirak99/process_graph --json comments --jq '.comments[-1].id // empty' 2>/dev/null) || exit 0; last=$(cat \\\"$WATCH_STATE/last\\\" 2>/dev/null); [ -n \\\"$latest\\\" ] && [ \\\"$latest\\\" != \\\"$last\\\" ] && { echo \\\"$latest\\\" > \\\"$WATCH_STATE/last\\\"; echo \\\"new comment on #157\\\"; exit 1; }; exit 0\"",
	"  Keep your cursor in $WATCH_STATE so restarts do not re-notify. The comment id is an opaque string: compare it, never parse it.",
	"  gh pr view --json comments covers only conversation replies, not inline review comments. Each poll spends GraphQL quota (~60 points/hour/watch at every 60s), so keep the number of watches modest. In process_graph workspaces, replace gh with $HOME/discord/server_devops/bin/gh-local per AGENTS.md.",
].join("\n");

const STREAM_EXAMPLE = [
	"Examples:",
	"- File change notifier (notifies on EVERY change; re-arms its own baseline):",
	"  run: \"f=/path/to/file; c=$WATCH_STATE/mtime; while sleep 5; do now=$(stat -c %Y \\\"$f\\\" 2>/dev/null || echo gone); last=$(cat \\\"$c\\\" 2>/dev/null); if [ \\\"$now\\\" != \\\"$last\\\" ]; then echo \\\"NOTIFY $f changed (mtime $now)\\\"; echo \\\"$now\\\" > \\\"$c\\\"; fi; done\"",
	"  with match=\"^NOTIFY\" only NOTIFY lines become events; without match, every non-empty stdout line is an event.",
	"- A clean exit is silent; on_finish=true requests one \"finished\" notification; any other exit is reported as \"broke\" and the script restarts with backoff.",
].join("\n");

export default function watchExtension(pi: ExtensionAPI) {
	const root = process.env.PI_WATCH_DIR ?? join(homedir(), ".pi", "pi-watch");
	const registry = new WatchRegistry(root);
	const outbox = new MessageStore(join(root, "outbox"));
	const supervisor = new WatchSupervisor(registry, async (watch, body) => {
		await outbox.sendDirect({ from: `watch:${watch.id}`, to: watch.session_id, body });
	});
	let delivery: InboxDelivery | undefined;
	let sessionId: string | undefined;
	// Set in session_start if another extension owns one of our tool names.
	// Every tool call refuses to run, loudly, instead of silently executing a
	// shadowing foreign tool.
	let loadConflict: string | null = null;

	function guardConflicts(): void {
		if (loadConflict) throw new Error(loadConflict);
	}

	async function startDelivery(ctx: ExtensionContext): Promise<void> {
		sessionId = ctx.sessionManager.getSessionId();
		delivery = new InboxDelivery(
			outbox,
			{
				resolveSender(message) {
					const id = message.metadata.from.startsWith("watch:") ? message.metadata.from.slice(6) : "";
					const watch = supervisor.getById(id);
					return Promise.resolve(senderIdentity(watch?.definition ?? { name: id, mode: "poll" } as WatchDefinition));
				},
				formatInline(sender, message) {
					return `${sender.name}:\n\n${message.body.trimEnd()}`;
				},
				formatReference(sender, message) {
					return `${sender.name} fired (message ${message.metadata.id}); use watch_tail for output.`;
				},
			},
			(prompt, message) => {
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				// Watch notifications are fire-and-forget: acknowledge immediately
				// so they are not re-delivered as backlog on the next session start.
				void outbox.markRead(message.metadata.to ?? "", message.metadata.id).catch(() => undefined);
			},
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Watch delivery error: ${error.message}`, "error");
			},
		);
		await delivery.start(sessionId);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Loud collision guard, deferred past extension loading (action methods
		// like getAllTools are not allowed while extensions load): every
		// watch_* tool must be ours; if another extension shadowed one, all
		// watch tools refuse to operate until the conflict is resolved.
		const existing = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const conflicts = TOOL_NAMES.filter((name) => {
			const tool = existing.get(name);
			return tool !== undefined && !JSON.stringify(tool.sourceInfo ?? "").includes("pi-watch");
		});
		if (conflicts.length > 0) {
			loadConflict =
				`pi-watch refused to operate: tool name(s) owned by another extension: ${conflicts.join(", ")}. ` +
				"Resolve the conflict; watch_* tool calls will fail until it is fixed.";
			if (ctx.hasUI) ctx.ui.notify(loadConflict, "error");
		}
		await delivery?.stop();
		delivery = undefined;
		await supervisor.restore();
		await startDelivery(ctx);
	});

	pi.on("session_shutdown", async () => {
		await supervisor.shutdown();
		await delivery?.stop();
		delivery = undefined;
	});

	pi.registerTool({
		name: "watch_create_poll",
		label: "Create poll watch",
		description:
			"Create a durable watch that runs a check command repeatedly and notifies you when its exit code is non-zero. " +
			"The command must finish quickly: exit 0 = silence (no tokens spent), exit 1 = one notification with the command's combined output, " +
			"any other exit, signal, or watchdog timeout = a \"broke\" notification (reported once per breakage). " +
			`Runs at most every ${MIN_EVERY_SECONDS} seconds (default ${DEFAULT_EVERY_SECONDS}); a single run is killed after timeout_seconds (default ${DEFAULT_TIMEOUT_SECONDS}). ` +
			"initial_delay_seconds postpones the very first run (default 0 = run immediately, which establishes the change-detection baseline). " +
			"Every fired notification ends with a stats footer: its sequence number and the time since the previous event. " +
			`Scripts get a private state directory in $WATCH_STATE (cursor files survive restarts). ${DECISION_RULE}\n${POLL_EXAMPLE}`,
		promptSnippet: "Create a durable poll watch: re-runs a check command, notifies when its exit code is non-zero",
		promptGuidelines: [
			"Use watch_create_poll when the user asks to monitor, watch, or be alerted about an external condition a short command can check.",
			"Use watch_create_poll when you must wait for an external condition instead of sleeping or polling within a turn.",
			"End poll commands with an explicit exit code: 0 for \"nothing to say\", 1 (with output) for \"event\", and never rely on a failing command's accidental exit code.",
			"Keep per-run state in $WATCH_STATE so a restarted watch does not re-notify old events.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Unique watch name (no '/')" }),
			run: Type.String({ description: "Check command, run via bash -c; must exit quickly" }),
			every_seconds: Type.Optional(Type.Number({ description: `Seconds between runs; integer >= ${MIN_EVERY_SECONDS}, default ${DEFAULT_EVERY_SECONDS}` })),
			initial_delay_seconds: Type.Optional(Type.Number({ description: "Seconds before the very first run; default 0 (immediate). Use to avoid firing right after registration." })),
			timeout_seconds: Type.Optional(Type.Number({ description: `Seconds before one run is killed; default ${DEFAULT_TIMEOUT_SECONDS}` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		guardConflicts();
			try {
				const definition = await supervisor.create({
					name: params.name,
					mode: "poll",
					run: params.run,
					everySeconds: params.every_seconds,
					initialDelaySeconds: params.initial_delay_seconds,
					timeoutSeconds: params.timeout_seconds,
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return toolResult({ watch: definition });
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_create_stream",
		label: "Create stream watch",
		description:
			"Create a durable watch that starts a listener command once and notifies you per stdout line. " +
			"Each non-empty stdout line matching match (a regular expression; default: every non-empty line) is one notification with the line as its message; " +
			"non-matching stdout lines and everything on stderr are captured to the watch log (readable with watch_tail) but never notify. " +
			"A clean exit (code 0) is silent; on_finish=true requests one \"finished\" notification with recent output; " +
			"any other exit or signal is reported once as \"broke\" and the script restarts with backoff. " +
			"There is no watch-level polling: the script owns its own cadence. Scripts get a private state directory in $WATCH_STATE. " +
			`${DECISION_RULE}\n${STREAM_EXAMPLE}`,
		promptSnippet: "Create a durable stream watch: runs a listener command once, notifies per matching stdout line",
		promptGuidelines: [
			"Use watch_create_stream for push-style sources (tail -f, journalctl -f, inotify waiters, socket listeners) or when the command announces events as they happen.",
			`Use watch_create_poll for quick yes/no checks instead; ${DECISION_RULE}`,
			"Only stdout can notify; use stderr for diagnostics you want logged but never delivered.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Unique watch name (no '/')" }),
			run: Type.String({ description: "Listener command, run once via bash -c; expected to run long" }),
			match: Type.Optional(Type.String({ description: "Regular expression; matching stdout lines become notifications (default: every non-empty line)" })),
			on_finish: Type.Optional(Type.Boolean({ description: "Notify once when the script exits cleanly (default false: clean exit is silent)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		guardConflicts();
			try {
				const definition = await supervisor.create({
					name: params.name,
					mode: "stream",
					run: params.run,
					match: params.match,
					onFinish: params.on_finish,
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return toolResult({ watch: definition });
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_list",
		label: "List watches",
		description: "List all watches with mode, status, and scheduling details. Definitions persist across Pi restarts; running processes do not (a restarted session shows watches as stopped until resumed).",
		promptSnippet: "List durable watches and their statuses",
		parameters: Type.Object({}),
		async execute() {
		guardConflicts();
			return toolResult({
				watch_root: root,
				watches: supervisor.list().map(({ definition, state }) => ({
					name: definition.name,
					id: definition.id,
					mode: definition.mode,
					status: state.status,
					run: definition.run,
					every_seconds: definition.every_seconds ?? null,
					match: definition.match ?? null,
					on_finish: definition.on_finish ?? false,
					broken: state.broken,
					pid: state.pid,
					exit_code: state.exit_code,
					next_run_at: state.next_run_at,
					created_at: definition.created_at,
				})),
			});
		},
	});

	pi.registerTool({
		name: "watch_inspect",
		label: "Inspect watch",
		description: "Show one watch's definition, runtime state, and recent status.",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				return toolResult(supervisor.get(params.name));
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_pause",
		label: "Pause watch",
		description: "Pause a watch: stop its script and suspend scheduling. Events are not generated while paused.",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.pause(params.name);
				return toolResult({ paused: params.name });
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_resume",
		label: "Resume watch",
		description: "Resume a paused or stopped watch: restart its script and scheduling.",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.resume(params.name);
				return toolResult({ resumed: params.name });
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_remove",
		label: "Remove watch",
		description: "Permanently remove a watch: stop its script and delete its definition. Logs and script state are kept for forensics.",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.remove(params.name);
				return toolResult({ removed: params.name });
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_tail",
		label: "Read watch output",
		description:
			"Read the tail of a watch's captured output. Lines are prefixed [stdout]: or [stderr]:; a final synthesized [status]: line reports live state " +
			"(\"script is still running\", \"script exited with code N\", \"watch is paused\", or restart scheduling). This is the full record of everything the script printed, including events suppressed by the notification rate limit.",
		promptSnippet: "Read a watch's captured stdout/stderr tail and its live status",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
			lines: Type.Optional(Type.Number({ description: "Number of log lines to read; default 50" })),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				const { state } = supervisor.get(params.name);
				const logLines = await supervisor.tail(params.name, params.lines ?? 50);
				return toolResult({ lines: logLines, status: statusLine(state) });
			} catch (error) {
				toWatchError(error);
			}
		},
	});
}
