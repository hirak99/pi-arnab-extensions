export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface JobTask {
	id: string;
	session_id: string;
	name: string;
	command: string;
	status: JobStatus;
	pid: number | null;
	output_path: string;
	created_at: string;
	completed_at: string | null;
	exit_code: number | null;
	signal: string | null;
	error: string | null;
	timeout_seconds: number | null;
	deadline_at: string | null;
}

export interface JobExport {
	bytes_written: number;
	omitted_lines?: number;
}

export interface JobLogs {
	text: string;
	tail: boolean;
	bytesRead: number;
	truncated: boolean;
	omitted_lines?: number;
}

export const DEFAULT_LOG_BYTES = 50_000;
export const MAX_LOG_BYTES = 50_000;
