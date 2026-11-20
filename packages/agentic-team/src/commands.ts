/**
 * Design intent: every human-facing team command starts with `team-` so related
 * commands stay together in autocomplete. Keep this convention for future
 * commands rather than adding aliases with other prefixes.
 */
export const TEAM_COMMANDS = {
	register: "team-agent-register",
	responsibilities: "team-agent-responsibilities",
} as const;
