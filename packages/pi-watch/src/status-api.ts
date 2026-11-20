import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { WatchDefinition, WatchRuntimeState } from "./types.ts";

export const WATCH_REQUEST_CHANNEL = "pi-watch:request:v1";
export const WATCH_RESPONSE_CHANNEL = "pi-watch:response:v1";
export const WATCH_REQUEST_SCHEMA = "pi-watch.extension-request.v1";
export const WATCH_RESPONSE_SCHEMA = "pi-watch.extension-response.v1";

export interface WatchStatusEntry {
	definition: WatchDefinition;
	state: WatchRuntimeState;
}

/**
 * Optional display API for other extensions. Consumers use the EventBus only;
 * pi-watch remains an optional dependency and no package import is required.
 */
export function registerWatchStatusApi(
	pi: Pick<ExtensionAPI, "events">,
	list: () => WatchStatusEntry[],
): () => void {
	return pi.events.on(WATCH_REQUEST_CHANNEL, (event: any) => {
		if (event?.schema_version !== WATCH_REQUEST_SCHEMA || event?.operation !== "status") return;
		if (typeof event?.request_id !== "string") return;

		let watches: Array<Record<string, unknown>>;
		try {
			watches = list().map(({ definition, state }) => ({
				name: definition.name,
				id: definition.id,
				mode: definition.mode,
				status: state.status,
				every_seconds: definition.every_seconds ?? null,
				broken: state.broken,
				restart_attempt: state.restart_attempt,
			}));
		} catch (error) {
			pi.events.emit(WATCH_RESPONSE_CHANNEL, {
				schema_version: WATCH_RESPONSE_SCHEMA,
				request_id: event.request_id,
				operation: "status",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		pi.events.emit(WATCH_RESPONSE_CHANNEL, {
			schema_version: WATCH_RESPONSE_SCHEMA,
			request_id: event.request_id,
			operation: "status",
			ok: true,
			result: { watches },
		});
	});
}
