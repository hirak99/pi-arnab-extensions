import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { InboxDelivery, MessageStore, sendNativeNotification } from "pi-durable-inbox";
import { temporaryOutputRoot } from "pi-output-store";

import { senderIdentity, statusLine } from "./format.ts";
import { WatchRegistry } from "./registry.ts";
import { registerWatchStatusApi } from "./status-api.ts";
import { colorStatus } from "./status-color.ts";
import { formatWatcherStatus } from "./status.ts";
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
	"watch_export",
] as const;

const WATCH_NOTIFICATION_TYPE = "watch-notification";
interface WatchNotificationDetails {
	senderName: string;
	messageId: string;
}

interface WatchReloadBridge {
	supervisor: WatchSupervisor;
	knownWatches?: Map<string, WatchDefinition>;
	sessionId: string;
	root: string;
}

// /reload replaces the extension runtime in the same Pi process. Keep the
// supervisor itself alive so watch scripts, timers, and in-memory rate limiting
// continue without a stop/start cycle. Full process shutdown never uses this.
const WATCH_RELOAD_BRIDGE_KEY = Symbol.for("pi-watch.reload-bridge");

function takeWatchReloadBridge(): WatchReloadBridge | null {
	const bridge = (Reflect.get(globalThis, WATCH_RELOAD_BRIDGE_KEY) ?? null) as WatchReloadBridge | null;
	Reflect.deleteProperty(globalThis, WATCH_RELOAD_BRIDGE_KEY);
	return bridge;
}

function storeWatchReloadBridge(bridge: WatchReloadBridge): void {
	Reflect.set(globalThis, WATCH_RELOAD_BRIDGE_KEY, bridge);
}

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
	"Watches are durable: definitions persist until watch_remove or automatic removal at max_events. " +
	"Running watches survive /reload without interruption and auto-resume after a full Pi restart only in their owning session, preserving any remaining scheduled delay; commands must be idempotent and use $WATCH_STATE for checkpoints.";

const USAGE_GUIDANCE =
	"Watches are best suited for recurring alerts or continuous monitoring. " +
	"If you have a mechanism to run background jobs with completion notifications, prefer it over a watch for strictly one-time work.";

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
	const registry = new WatchRegistry(root, process.env.PI_WATCH_LOG_DIR ?? temporaryOutputRoot("pi-watch"));
	const outbox = new MessageStore(join(root, "outbox"));
	// Runtime-only sender identities let inbox rendering keep a watch's name
	// after max_events auto-removal without retaining an active definition.
	const knownWatches = new Map<string, WatchDefinition>();
	const deliver = async (watch: WatchDefinition, body: string) => {
		knownWatches.set(watch.id, watch);
		await outbox.sendDirect({ from: `watch:${watch.id}`, to: watch.session_id, body });
	};
	const onStateChange = () => refreshWatchStatus();
	let supervisor = new WatchSupervisor(registry, deliver, { onStateChange });
	let statusApiUnsub: (() => void) | undefined = registerWatchStatusApi(pi, () => supervisor.list(owningSessionId()));
	let delivery: InboxDelivery | undefined;
	let sessionId: string | undefined;
	let statusUi: ExtensionContext["ui"] | undefined;

	pi.registerMessageRenderer<WatchNotificationDetails>(WATCH_NOTIFICATION_TYPE, (message, _options, theme) => {
		const details = message.details;
		const sender = details?.senderName ?? "Watch notification";
		const id = details?.messageId ? ` ${theme.fg("dim", `(${details.messageId})`)}` : "";
		return new Text(`${theme.fg("accent", "[watch]")} ${theme.fg("accent", sender)}${id}`, 0, 0);
	});
	// Set in session_start if another extension owns one of our tool names.
	// Every tool call refuses to run, loudly, instead of silently executing a
	// shadowing foreign tool.
	let loadConflict: string | null = null;

	function guardConflicts(): void {
		if (loadConflict) throw new Error(loadConflict);
	}

	function owningSessionId(): string {
		if (!sessionId) throw new WatchError("watch session is not initialized");
		return sessionId;
	}

	function refreshWatchStatus(): void {
		if (!statusUi || !sessionId) return;
		const watches = supervisor.list(sessionId);
		const text = formatWatcherStatus(watches);
		const active = watches.filter(({ state }) => state.status === "running").length;
		const paused = watches.filter(({ state }) => state.status === "paused").length;
		const broken = watches.filter(({ state }) => state.broken).length;
		const highlights = [
			...(paused > 0 ? [{ text: `${paused} paused`, tone: "warning" as const }] : []),
			...(broken > 0 ? [{ text: `${broken} broken`, tone: "error" as const }] : []),
		];
		const tone = active === watches.length ? "info" : "warning";
		statusUi.setStatus("pi-watch", text ? colorStatus(text, tone, process.env, highlights) : undefined);
	}

	async function startDelivery(ctx: ExtensionContext): Promise<void> {
		sessionId = ctx.sessionManager.getSessionId();
		delivery = new InboxDelivery(
			outbox,
			{
				resolveSender(message) {
					const id = message.metadata.from.startsWith("watch:") ? message.metadata.from.slice(6) : "";
					const watch = supervisor.getById(id);
					return Promise.resolve(senderIdentity(watch?.definition ?? knownWatches.get(id) ?? { name: id, mode: "poll" } as WatchDefinition));
				},
				formatInline(sender, message) {
					return `${sender.name}:\n\n${message.body.trimEnd()}`;
				},
				formatReference(sender, message) {
					return `${sender.name} fired (message ${message.metadata.id}); use watch_tail for output.`;
				},
			},
			async (prompt, message, sender) => {
				sendNativeNotification(pi, {
					customType: WATCH_NOTIFICATION_TYPE,
					content: prompt,
					details: { senderName: sender.name, messageId: message.metadata.id },
				});
				// Acknowledge within the tracked delivery queue so reload teardown
				// waits for the durable receipt before the next backlog scan.
				await outbox.markRead(message.metadata.to ?? "", message.metadata.id).catch(() => undefined);
			},
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Watch delivery error: ${error.message}`, "error");
			},
		);
		await delivery.start(sessionId);
	}

	pi.on("session_start", async (_event, ctx) => {
		statusUi?.setStatus("pi-watch", undefined);
		statusUi = undefined;
		sessionId = undefined;
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
		knownWatches.clear();
		const nextSessionId = ctx.sessionManager.getSessionId();
		const bridge = takeWatchReloadBridge();
		let definitions: WatchDefinition[];
		if (bridge && _event?.reason === "reload" && bridge.sessionId === nextSessionId && bridge.root === root) {
			supervisor = bridge.supervisor;
			supervisor.rebind(deliver, onStateChange);
			for (const [id, definition] of bridge.knownWatches ?? []) knownWatches.set(id, definition);
			definitions = supervisor.list(nextSessionId).map(({ definition }) => definition);
		} else {
			// A mismatched abandoned bridge must never leak processes into another
			// session. Its shutdown preserves intent for its own later resume.
			if (bridge) await bridge.supervisor.shutdown();
			definitions = await supervisor.restore(nextSessionId);
		}
		for (const definition of definitions) knownWatches.set(definition.id, definition);
		await startDelivery(ctx);
		statusUi = ctx.hasUI ? ctx.ui : undefined;
		refreshWatchStatus();
	});

	pi.on("session_shutdown", async (event) => {
		statusUi?.setStatus("pi-watch", undefined);
		statusUi = undefined;
		const previousSessionId = sessionId;
		sessionId = undefined;
		statusApiUnsub?.();
		statusApiUnsub = undefined;
		if (event?.reason === "reload" && previousSessionId) {
			storeWatchReloadBridge({ supervisor, knownWatches, sessionId: previousSessionId, root });
		} else {
			await supervisor.shutdown();
		}
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
			"max_events is an optional lifetime cap on alert events; reaching it delivers the final batch, deletes temporary output, and removes the watch (script state remains on disk). " +
			`Scripts get a private state directory in $WATCH_STATE (cursor files survive restarts). ${DECISION_RULE}\n${POLL_EXAMPLE}`,
		promptSnippet: "Create a durable poll watch: re-runs a check command, notifies when its exit code is non-zero",
		promptGuidelines: [
			"Use watch_create_poll when the user asks to monitor, watch, or be alerted about an external condition a short command can check.",
			USAGE_GUIDANCE,
			"Set max_events=1 for a one-shot alert: the first exit-1 event is delivered, then the watch is automatically removed.",
			"End poll commands with an explicit exit code: 0 for \"nothing to say\", 1 (with output) for \"event\", and never rely on a failing command's accidental exit code.",
			"Keep per-run state in $WATCH_STATE so a restarted watch does not re-notify old events.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Unique watch name in this session (no '/')" }),
			run: Type.String({ description: "Check command, run via bash -c; must exit quickly" }),
			every_seconds: Type.Optional(Type.Number({ description: `Seconds between runs; integer >= ${MIN_EVERY_SECONDS}, default ${DEFAULT_EVERY_SECONDS}` })),
			initial_delay_seconds: Type.Optional(Type.Number({ description: "Seconds before the very first run; default 0 (immediate). Use to avoid firing right after registration." })),
			timeout_seconds: Type.Optional(Type.Number({ description: `Seconds before one run is killed; default ${DEFAULT_TIMEOUT_SECONDS}` })),
			max_events: Type.Optional(Type.Number({ description: "Lifetime number of exit-1 alerts before automatic removal; integer >= 1, default unlimited" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		guardConflicts();
			try {
				await supervisor.create({
					name: params.name,
					mode: "poll",
					run: params.run,
					everySeconds: params.every_seconds,
					initialDelaySeconds: params.initial_delay_seconds,
					timeoutSeconds: params.timeout_seconds,
					maxEvents: params.max_events,
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return { content: [{ type: "text" as const, text: "Watch created." }], details: { created: true } };
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
			"max_events is an optional lifetime cap on matching stdout events; reaching it delivers the final batch and removes the watch without an extra finish notification. " +
			`${DECISION_RULE}\n${STREAM_EXAMPLE}`,
		promptSnippet: "Create a durable stream watch: runs a listener command once, notifies per matching stdout line",
		promptGuidelines: [
			"Use watch_create_stream for push-style sources (tail -f, journalctl -f, inotify waiters, socket listeners) or when the command announces events as they happen.",
			USAGE_GUIDANCE,
			"For a one-shot stream alert, set max_events=1: the first matching stdout line is delivered, then the watch is automatically removed.",
			`Use watch_create_poll for quick yes/no checks instead; ${DECISION_RULE}`,
			"Only stdout can notify; use stderr for diagnostics you want logged but never delivered.",
			"Full Pi/system restart relaunches stream commands from the beginning; checkpoint any required time-sensitive progress in $WATCH_STATE.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Unique watch name in this session (no '/')" }),
			run: Type.String({ description: "Listener command, run once via bash -c; expected to run long" }),
			match: Type.Optional(Type.String({ description: "Regular expression; matching stdout lines become notifications (default: every non-empty line)" })),
			on_finish: Type.Optional(Type.Boolean({ description: "Notify once when the script exits cleanly (default false: clean exit is silent)" })),
			max_events: Type.Optional(Type.Number({ description: "Lifetime number of matching stdout alerts before automatic removal; integer >= 1, default unlimited. Set 1 for a one-shot alert" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		guardConflicts();
			try {
				await supervisor.create({
					name: params.name,
					mode: "stream",
					run: params.run,
					match: params.match,
					onFinish: params.on_finish,
					maxEvents: params.max_events,
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return { content: [{ type: "text" as const, text: "Watch created." }], details: { created: true } };
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_list",
		label: "List watches",
		description: "List the current session's watches with mode, status, and scheduling details. Running watches survive /reload without interruption and auto-resume after a full Pi restart only in their owning session; paused and stopped watches remain inactive.",
		promptSnippet: "List the current session's durable watches and their statuses",
		parameters: Type.Object({}),
		async execute() {
		guardConflicts();
			return toolResult({
				watches: supervisor.list(owningSessionId()).map(({ definition, state }) => ({
					name: definition.name,
					mode: definition.mode,
					status: state.status,
					every_seconds: definition.every_seconds ?? null,
					broken: state.broken,
					next_run_at: state.next_run_at,
					event_count: state.event_count,
					last_fired_at: state.last_fired_at,
				})),
			});
		},
	});

	pi.registerTool({
		name: "watch_inspect",
		label: "Inspect watch",
		description: "Show one watch's definition, runtime state, and recent status.",
		promptSnippet: "Inspect one durable watch's definition and runtime state",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				return toolResult(supervisor.get(params.name, owningSessionId()));
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_pause",
		label: "Pause watch",
		description: "Pause a watch: stop its script and suspend scheduling. Events are not generated while paused. Paused watches do not auto-resume on reload or restart.",
		promptSnippet: "Pause a durable watch without deleting its definition",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.pause(params.name, owningSessionId());
				return { content: [{ type: "text" as const, text: "Watch paused." }], details: { paused: true } };
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_resume",
		label: "Resume watch",
		description: "Resume a paused or stopped watch: restart its script and scheduling.",
		promptSnippet: "Resume a paused or stopped durable watch",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.resume(params.name, owningSessionId());
				return { content: [{ type: "text" as const, text: "Watch resumed." }], details: { resumed: true } };
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_remove",
		label: "Remove watch",
		description: "Permanently remove a watch: stop its script, delete its definition, and delete all temporary output segments. Script state is kept for forensics.",
		promptSnippet: "Permanently remove a watch and its temporary output while retaining script state",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
		}),
		async execute(_toolCallId, params) {
		guardConflicts();
			try {
				await supervisor.remove(params.name, owningSessionId());
				return { content: [{ type: "text" as const, text: "Watch removed." }], details: { removed: true } };
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_tail",
		label: "Read watch output",
		description:
			"Read recent retained output from a watch's private temporary log. Lines are prefixed [stdout]: or [stderr]:; a final synthesized [status]: line reports live state " +
			"(\"script is still running\", \"script exited with code N\", \"watch is paused\", or restart scheduling). Output uses two-segment byte rotation; omitted_lines is returned only when older lines were physically discarded.",
		promptSnippet: "Read a watch's captured stdout/stderr tail and its live status",
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
			lines: Type.Optional(Type.Number({ description: "Number of log lines to read; default 50" })),
		}),
		async execute(_toolCallId, params) {
			guardConflicts();
			try {
				const { state } = supervisor.get(params.name, owningSessionId());
				const result = await supervisor.tailDetails(params.name, owningSessionId(), params.lines ?? 50);
				return toolResult({
					lines: result.lines,
					status: statusLine(state),
					...(result.omittedLines > 0 ? { omitted_lines: result.omittedLines } : {}),
				});
			} catch (error) {
				toWatchError(error);
			}
		},
	});

	pi.registerTool({
		name: "watch_export",
		label: "Export watch output",
		description: "Atomically save a consistent point-in-time snapshot of all retained watch output to an explicit destination. Exports both retained segments in chronological order and is not limited by the watch_tail line cap. Existing destinations are refused unless overwrite is true. Exported files survive watch removal. Automatic max_events removal still deletes internal output, so export before removal when preservation is required.",
		promptSnippet: "Save all retained watch output to a permanent file",
		promptGuidelines: [
			"Use watch_export only when retained output must be saved permanently; use watch_tail for ordinary bounded inspection.",
			"For a running watch, the snapshot includes output captured at export time. Relative destinations resolve against the session working directory.",
			"Export before watch_remove or automatic max_events removal if the output must be preserved. Exported files are never removed by watch lifecycle operations.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Watch name" }),
			path: Type.String({ minLength: 1, description: "Destination file path, absolute or relative to the session working directory" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing destination atomically when true; default false" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			guardConflicts();
			try {
				const result = await supervisor.exportOutput(params.name, owningSessionId(), resolve(ctx.cwd, params.path), params.overwrite ?? false);
				return toolResult({
					bytes_written: result.bytesWritten,
					...(result.omittedLines > 0 ? { omitted_lines: result.omittedLines } : {}),
				});
			} catch (error) {
				toWatchError(error);
			}
		},
	});
}
