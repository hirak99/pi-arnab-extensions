import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JobTask } from "./types.ts";

export const JOB_REQUEST_CHANNEL = "pi-background-jobs:request:v1";
export const JOB_RESPONSE_CHANNEL = "pi-background-jobs:response:v1";
export const JOB_REQUEST_SCHEMA = "pi-background-jobs.extension-request.v1";
export const JOB_RESPONSE_SCHEMA = "pi-background-jobs.extension-response.v1";

/** Optional display-only status API; no package import or producer dependency is required. */
export function registerJobStatusApi(
	pi: Pick<ExtensionAPI, "events">,
	list: () => JobTask[],
): () => void {
	return pi.events.on(JOB_REQUEST_CHANNEL, (event: any) => {
		if (event?.schema_version !== JOB_REQUEST_SCHEMA || event?.operation !== "status") return;
		if (typeof event?.request_id !== "string") return;
		try {
			const tasks = list().map((task) => ({
				id: task.id,
				name: task.name,
				status: task.status,
			}));
			pi.events.emit(JOB_RESPONSE_CHANNEL, {
				schema_version: JOB_RESPONSE_SCHEMA,
				request_id: event.request_id,
				operation: "status",
				ok: true,
				result: { tasks },
			});
		} catch (error) {
			pi.events.emit(JOB_RESPONSE_CHANNEL, {
				schema_version: JOB_RESPONSE_SCHEMA,
				request_id: event.request_id,
				operation: "status",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
