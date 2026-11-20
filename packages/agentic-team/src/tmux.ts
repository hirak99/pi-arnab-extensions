import { execFile } from "node:child_process";

import type { TeamTransport } from "./types.ts";

interface ExecResult {
	stdout: string;
	stderr: string;
}

function runTmux(args: string[], signal?: AbortSignal): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { encoding: "utf8", signal, timeout: 10_000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`tmux command failed: ${stderr.trim() || error.message}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function tmuxPrefix(transport: Extract<TeamTransport, { type: "tmux" }>): string[] {
	return transport.socket ? ["-S", transport.socket] : [];
}

export function detectTmuxTransport(env: NodeJS.ProcessEnv = process.env): TeamTransport {
	const pane = env.TMUX_PANE;
	if (!pane || !/^%\d+$/.test(pane)) return { type: "none" };
	const socket = env.TMUX?.split(",", 1)[0];
	return socket ? { type: "tmux", pane, socket } : { type: "tmux", pane };
}

export async function tmuxPaneExists(
	transport: Extract<TeamTransport, { type: "tmux" }>,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const result = await runTmux(
			[...tmuxPrefix(transport), "display-message", "-p", "-t", transport.pane, "#{pane_id}"],
			signal,
		);
		return result.stdout.trim() === transport.pane;
	} catch {
		return false;
	}
}
