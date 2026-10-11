import type { Message } from "@earendil-works/pi-ai";
import type { Polls } from "./polls.ts";

const PREFIX = "[Current Telegram poll observations] ";

/** Append changed observations to the current input; leave previous messages and stable instructions untouched. */
export function pollContext(polls: Awaited<ReturnType<Polls["current"]>>, messages: readonly Message[]): string | undefined {
	const seen = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		for (const line of text.split("\n")) if (line.startsWith(PREFIX)) {
			try {
				for (const row of JSON.parse(line.slice(PREFIX.length))) seen.set(row.poll.id, JSON.stringify(row));
			} catch { /* A user's text resembling the marker is not an observation. */ }
		}
	}
	const changed = polls.filter((row) => seen.get(row.poll.id) !== JSON.stringify(row));
	return changed.length ? PREFIX + JSON.stringify(changed) : undefined;
}
