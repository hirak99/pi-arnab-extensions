import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sendNativeNotification } from "pi-durable-inbox";
import { Type } from "typebox";

import { formatJobList, formatJobsStatus, jobNotificationText } from "./format.ts";
import { registerJobStatusApi } from "./status-api.ts";
import { JobSupervisor } from "./supervisor.ts";
import type { JobTask } from "./types.ts";

const TOOL_NAMES = ["job_run", "job_status", "job_logs", "job_kill"] as const;
const JOB_NOTIFICATION_TYPE = "background-job-finished";
const RELOAD_BRIDGE_KEY = Symbol.for("pi-background-jobs.supervisor");

interface JobNotificationDetails {
	id: string;
	name: string;
	status: JobTask["status"];
	outputPath: string;
	error: string | null;
}

interface JobReloadBridge {
	supervisor: JobSupervisor;
	sessionId: string;
	root: string;
}

function takeReloadBridge(): JobReloadBridge | null {
	const bridge = (Reflect.get(globalThis, RELOAD_BRIDGE_KEY) ?? null) as JobReloadBridge | null;
	Reflect.deleteProperty(globalThis, RELOAD_BRIDGE_KEY);
	return bridge;
}

function toolResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

export default function backgroundJobsExtension(pi: ExtensionAPI) {
	const root = process.env.PI_JOBS_DIR ?? join(process.cwd(), ".pi", "jobs");
	let sessionId: string | undefined;
	let statusUi: ExtensionContext["ui"] | undefined;
	let loadConflict: string | null = null;

	const deliver = (task: JobTask): void => {
		const details: JobNotificationDetails = {
			id: task.id,
			name: task.name,
			status: task.status,
			outputPath: task.output_path,
			error: task.error,
		};
		sendNativeNotification(pi, {
			customType: JOB_NOTIFICATION_TYPE,
			content: jobNotificationText(task),
			details,
		});
	};
	const onStateChange = (): void => refreshStatus();
	const onError = (error: Error): void => {
		statusUi?.notify(`Background job error: ${error.message}`, "error");
	};
	let supervisor = new JobSupervisor(root, deliver, onStateChange, onError);

	function owningSessionId(): string {
		if (!sessionId) throw new Error("job session is not initialized");
		return sessionId;
	}

	function refreshStatus(): void {
		if (!statusUi || !sessionId) return;
		statusUi.setStatus(
			"pi-background-jobs",
			formatJobsStatus(supervisor.list(sessionId), supervisor.unseenFinished(sessionId)),
		);
	}

	function guardConflicts(): void {
		if (loadConflict) throw new Error(loadConflict);
	}

	const statusApiUnsub = registerJobStatusApi(pi, () => sessionId ? supervisor.list(sessionId) : []);

	pi.registerMessageRenderer<JobNotificationDetails>(JOB_NOTIFICATION_TYPE, (message, _options, theme) => {
		const task = message.details;
		const status = task?.status ?? "completed";
		const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "killed" ? "warning" : "accent";
		const name = task?.name ?? "Background job";
		const id = task?.id ?? "unknown";
		const output = task?.outputPath ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}` : "";
		const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
		return new Text(`${theme.fg(color, `[job ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`, 0, 0);
	});

	pi.on("session_start", async (event, ctx) => {
		statusUi?.setStatus("pi-background-jobs", undefined);
		sessionId = undefined;
		const existing = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const conflicts = TOOL_NAMES.filter((name) => {
			const tool = existing.get(name);
			return tool !== undefined && !JSON.stringify(tool.sourceInfo ?? "").includes("pi-background-jobs");
		});
		loadConflict = conflicts.length
			? `pi-background-jobs refused to operate: job tool names are owned by another extension: ${conflicts.join(", ")}`
			: null;
		if (loadConflict && ctx.hasUI) ctx.ui.notify(loadConflict, "error");

		const nextSessionId = ctx.sessionManager.getSessionId();
		const bridge = takeReloadBridge();
		statusUi = ctx.hasUI ? ctx.ui : undefined;
		sessionId = nextSessionId;
		if (bridge && event?.reason === "reload" && bridge.sessionId === nextSessionId && bridge.root === root) {
			supervisor = bridge.supervisor;
			supervisor.rebind(deliver, onStateChange, onError);
		} else {
			if (bridge) await bridge.supervisor.shutdown();
			await supervisor.restore(nextSessionId);
			refreshStatus();
		}
	});

	pi.on("session_shutdown", async (event) => {
		statusUi?.setStatus("pi-background-jobs", undefined);
		statusUi = undefined;
		statusApiUnsub();
		const previousSessionId = sessionId;
		sessionId = undefined;
		if (event?.reason === "reload" && previousSessionId) {
			supervisor.detach();
			Reflect.set(globalThis, RELOAD_BRIDGE_KEY, { supervisor, sessionId: previousSessionId, root } satisfies JobReloadBridge);
		} else {
			await supervisor.shutdown();
		}
	});

	pi.registerCommand("jobs", {
		description: "List session background jobs, or permanently remove finished jobs with /jobs clear",
		getArgumentCompletions: (prefix) => {
			if (!"clear".startsWith(prefix.trim())) return null;
			return [{ value: "clear", label: "clear", description: "Remove finished jobs, metadata, and logs" }];
		},
		handler: async (args, ctx) => {
			const currentSession = owningSessionId();
			const action = args.trim();
			if (action === "clear") {
				const removed = await supervisor.clearFinished(currentSession);
				ctx.ui.notify(`Removed ${removed} finished job${removed === 1 ? "" : "s"}.`, "info");
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /jobs [clear]", "warning");
				return;
			}
			ctx.ui.notify(formatJobList(supervisor.list(currentSession)), "info");
			supervisor.markSeen(currentSession);
		},
	});

	pi.registerTool({
		name: "job_run",
		label: "Run background job",
		description: "Start a named long-running shell command as a background job and return immediately with a task ID and output path. Every job survives /reload with the same PID, streams, and absolute timeout. Full Pi shutdown stops running jobs; restart retains history but never relaunches them. Completion automatically sends a native notification and follow-up turn.",
		promptSnippet: "Start a background shell job that survives /reload and notifies on completion",
		promptGuidelines: [
			"Use job_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
			"job_run returns immediately. Do not sleep or repeatedly call job_status/job_logs merely to wait; the terminal notification starts a follow-up turn.",
			"Use job_status for deliberate inspection and job_logs only when output is needed. Use job_kill when the user asks to stop a job or it is no longer needed.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short human-readable job name for the footer and notifications" }),
			command: Type.String({ description: "Shell command, executed as /bin/bash -c with the current environment" }),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Optional absolute timeout in integer seconds; not reset by /reload" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			guardConflicts();
			const task = await supervisor.start(owningSessionId(), {
				name: params.name,
				command: params.command,
				cwd: ctx.cwd,
				timeoutSeconds: params.timeoutSeconds,
			});
			return toolResult({ task, notification: "on_completion", reload: "preserved" });
		},
	});

	pi.registerTool({
		name: "job_status",
		label: "Background job status",
		description: "Inspect one background job by exact ID or unique prefix, or list all running/recent jobs owned by this session. This is point-in-time inspection, not a waiting primitive.",
		promptSnippet: "Inspect this session's background jobs without polling",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Optional exact job ID or unique prefix" })),
		}),
		execute(_toolCallId, params) {
			guardConflicts();
			const currentSession = owningSessionId();
			const tasks = params.taskId
				? [{ ...supervisor.resolve(params.taskId, currentSession).task }]
				: supervisor.list(currentSession);
			return Promise.resolve(toolResult({ tasks }));
		},
	});

	pi.registerTool({
		name: "job_logs",
		label: "Background job logs",
		description: "Read bounded output from a background job owned by this session. Output is capped at 50 KB for model safety and includes the full output path when truncated.",
		promptSnippet: "Read bounded background-job output when needed",
		parameters: Type.Object({
			taskId: Type.String({ description: "Exact job ID or unique prefix" }),
			maxBytes: Type.Optional(Type.Number({ description: "Bytes to read, from 1 to 50000; default 50000" })),
			tail: Type.Optional(Type.Boolean({ description: "Read the tail when true (default), otherwise the head" })),
		}),
		async execute(_toolCallId, params) {
			guardConflicts();
			const logs = await supervisor.readLogs(params.taskId, owningSessionId(), params.tail ?? true, params.maxBytes);
			const prefix = logs.truncated ? `Showing ${logs.tail ? "last" : "first"} ${logs.bytesRead} bytes. Full output: ${logs.path}\n\n` : "";
			return {
				content: [{ type: "text" as const, text: prefix + logs.text }],
				details: logs,
			};
		},
	});

	pi.registerTool({
		name: "job_kill",
		label: "Kill background job",
		description: "Stop a running background job owned by this session, including its POSIX process group. Waits for final status and flushed output.",
		promptSnippet: "Stop a running background job by ID",
		parameters: Type.Object({
			taskId: Type.String({ description: "Exact job ID or unique prefix" }),
		}),
		async execute(_toolCallId, params) {
			guardConflicts();
			const task = await supervisor.kill(params.taskId, owningSessionId());
			return toolResult({ task, output: task.output_path });
		},
	});
}
