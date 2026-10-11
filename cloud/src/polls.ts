/** Aggregate results, including anonymous polls. Individual voter identities are not needed. */
export type Poll = {
	id: string;
	question: string;
	options: { text: string; voter_count: number }[];
	total_voter_count: number;
	is_closed: boolean;
	is_anonymous: boolean;
};

export function isPoll(value: unknown): value is Poll {
	if (!value || typeof value !== "object") return false;
	return "id" in value && typeof value.id === "string" && "question" in value && typeof value.question === "string"
		&& "options" in value && Array.isArray(value.options) && "total_voter_count" in value && typeof value.total_voter_count === "number";
}

const TABLE = `CREATE TABLE IF NOT EXISTS telegram_polls (
	poll_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER,
	poll_json TEXT NOT NULL, update_id INTEGER)`;

type Row = { poll_json: string; message_id: number | null; update_id: number | null };

/** Poll updates carry an ID but no chat. The sent message establishes ownership before totals can be routed. */
export class Polls {
	private ready?: Promise<unknown>;
	private readonly db: D1Database;
	constructor(db: D1Database) { this.db = db; }
	private ensure(): Promise<unknown> {
		return this.ready ??= this.db.prepare(TABLE).run().catch((error) => { this.ready = undefined; throw error; });
	}

	/** Initial send results never overwrite a later vote update, including when history is recovered after a restart. */
	async remember(chatId: number, messageId: number | undefined, poll: Poll): Promise<void> {
		await this.ensure();
		await this.db.prepare("INSERT OR IGNORE INTO telegram_polls (poll_id, chat_id, message_id, poll_json) VALUES (?, ?, ?, ?)")
			.bind(poll.id, chatId, messageId ?? null, JSON.stringify(poll)).run();
	}

	async owner(pollId: string): Promise<number | undefined> {
		await this.ensure();
		return (await this.db.prepare("SELECT chat_id FROM telegram_polls WHERE poll_id = ?").bind(pollId).first<{ chat_id: number }>())?.chat_id;
	}

	/** Telegram's update IDs order snapshots; webhook retries or older snapshots cannot roll totals backwards. */
	async update(poll: Poll, updateId: number): Promise<void> {
		await this.ensure();
		await this.db.prepare("UPDATE telegram_polls SET poll_json = ?, update_id = ? WHERE poll_id = ? AND (update_id IS NULL OR update_id < ?)")
			.bind(JSON.stringify(poll), updateId, poll.id, updateId).run();
	}

	async current(chatId: number, pollId?: string) {
		await this.ensure();
		const query = pollId
			? this.db.prepare("SELECT poll_json, message_id, update_id FROM telegram_polls WHERE chat_id = ? AND poll_id = ?").bind(chatId, pollId)
			: this.db.prepare("SELECT poll_json, message_id, update_id FROM telegram_polls WHERE chat_id = ? ORDER BY rowid DESC LIMIT 5").bind(chatId);
		return (await query.all<Row>()).results.map((row) => ({
			poll: JSON.parse(row.poll_json) as Poll,
			message_id: row.message_id,
			observation: row.update_id === null ? "at_send" : "updated",
			telegram_update_id: row.update_id,
		}));
	}

	/** Record the poll embedded in sendPoll's Message result. */
	async sent(chatId: number, result: unknown): Promise<void> {
		if (result && typeof result === "object" && "poll" in result && isPoll(result.poll)) {
			const messageId = "message_id" in result && typeof result.message_id === "number" ? result.message_id : undefined;
			await this.remember(chatId, messageId, result.poll);
		}
	}
}
