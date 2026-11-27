import type { JobTask } from "./types.ts";

export function formatJobsStatus(tasks: JobTask[], unseenFinished: JobTask[]): string | undefined {
	const running = tasks.filter((task) => task.status === "running").length;
	const done = unseenFinished.filter((task) => task.status === "completed").length;
	const failed = unseenFinished.filter((task) => task.status === "failed").length;
	const killed = unseenFinished.filter((task) => task.status === "killed").length;
	if (running + done + failed + killed === 0) return undefined;
	const parts: string[] = [];
	if (running) parts.push(`${running} running`);
	if (failed) parts.push(`${failed} failed`);
	if (killed) parts.push(`${killed} stopped`);
	if (done) parts.push(`${done} done`);
	return ` jobs ${parts.join(" · ")} · /job `;
}

export function formatJobList(tasks: JobTask[]): string {
	if (tasks.length === 0) return "No background jobs in this session.";
	return tasks.map((task) => {
		const runtime = task.completed_at
			? `finished ${task.completed_at}`
			: `started ${task.created_at}${task.pid ? ` · PID ${task.pid}` : ""}`;
		return `${task.id}  ${task.status}  ${task.name}\n  ${runtime}\n  Output: ${task.output_path}`;
	}).join("\n\n");
}

export function jobNotificationText(task: JobTask): string {
	const outcome = task.status === "completed"
		? "completed successfully"
		: task.status === "killed"
			? "was stopped"
			: "failed";
	const exit = task.exit_code !== null ? ` Exit code: ${task.exit_code}.` : "";
	const error = task.error ? ` ${task.error}` : "";
	return [
		`<background-job-finished>`,
		`Background job ${JSON.stringify(task.name)} (${task.id}) ${outcome}.${exit}${error}`,
		`Output: ${task.output_path}`,
		`Use job_logs with taskId ${task.id} if output is needed.`,
		`</background-job-finished>`,
	].join("\n");
}
