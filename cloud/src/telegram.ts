/** Telegram's limits for one plain and one rich message. The plain one counts UTF-16 code units, as strings here do. */
const MAX_MESSAGE = 4096;
const MAX_RICH = 30000;

/** A refusal by Telegram. A permanent one can never succeed on a retry. */
export class TelegramError extends Error {
	readonly permanent: boolean;
	/** Seconds Telegram asks to wait, or 0. */
	readonly retryAfter: number;

	constructor(description: string, code: number, retryAfter = 0) {
		super(`telegram ${code}: ${description}`);
		this.permanent = code === 400 || code === 403;
		this.retryAfter = retryAfter;
	}
}

/** Cut text into pieces of at most `limit` code units, at a newline when one is close enough, never inside a character. */
export function splitText(text: string, limit: number): string[] {
	const parts: string[] = [];
	while (text.length > 0) {
		let end = Math.min(limit, text.length);
		// Not between the two halves of a surrogate pair.
		if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
		if (end < text.length) {
			const newline = text.lastIndexOf("\n", end - 1) + 1;
			if (newline > end / 2) end = newline;
		}
		parts.push(text.slice(0, end));
		text = text.slice(end);
	}
	return parts;
}

export type Command = { command: string; description: string };

export class Telegram {
	private readonly api: string;
	private readonly token: string;

	/** `api` is the Bot API's origin, which only tests point elsewhere. */
	constructor(token: string, api = "https://api.telegram.org") {
		this.api = api;
		this.token = token;
	}

	/** Run one Bot API method and return its result. */
	async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		const encoded = Object.fromEntries(Object.entries(params)
			.filter(([, value]) => value !== undefined && value !== null)
			.map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
		let response: Response;
		try {
			response = await fetch(`${this.api}/bot${this.token}/${method}`, { method: "POST", body: new URLSearchParams(encoded) });
		} catch {
			// The error would carry the URL, which holds the bot token.
			throw new Error("telegram unreachable");
		}
		const body = (await response.json().catch(() => undefined)) as
			| { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
			| undefined;
		if (!body) throw new Error(`telegram answered ${response.status} without JSON`);
		if (!body.ok) throw new TelegramError(body.description ?? "", body.error_code ?? response.status, body.parameters?.retry_after);
		return body.result as T;
	}

	/** Send Markdown as rich messages, and as plain text when Telegram cannot take it that way. */
	async send(chatId: number, markdown: string): Promise<void> {
		for (const part of splitText(markdown, MAX_RICH)) {
			try {
				await this.call("sendRichMessage", { chat_id: String(chatId), rich_message: JSON.stringify({ markdown: part }) });
			} catch (error) {
				if (!(error instanceof TelegramError) || !error.permanent) throw error;
				for (const plain of splitText(part, MAX_MESSAGE)) await this.call("sendMessage", { chat_id: String(chatId), text: plain });
			}
		}
	}

	/** Show work in progress: a streamed draft with a stop button in private chats, "typing" elsewhere. */
	async draft(chatId: number, draftId: number, markdown: string): Promise<void> {
		// Drafts exist only in private chats, which have positive IDs.
		if (chatId < 0) {
			await this.call("sendChatAction", { chat_id: String(chatId), action: "typing" });
			return;
		}
		const draft = { chat_id: String(chatId), draft_id: String(draftId), can_stop: "true" };
		// Without text, Telegram shows its own placeholder.
		if (markdown === "") await this.call("sendMessageDraft", draft);
		else await this.call("sendRichMessageDraft", { ...draft, rich_message: JSON.stringify({ markdown: splitText(markdown, MAX_RICH).at(-1) }) });
	}

	/** The bytes of a file a message carried. Telegram hands bots files of up to 20MB. */
	async download(fileId: string): Promise<Uint8Array> {
		const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
		if (!file.file_path) throw new Error("getFile gave no file path");
		let response: Response;
		try {
			response = await fetch(`${this.api}/file/bot${this.token}/${file.file_path}`);
		} catch {
			throw new Error("telegram unreachable");
		}
		if (!response.ok) throw new Error(`file download answered ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Point Telegram at this Worker, and publish the command menu. */
	async setUp(webhookUrl: string, secret: string, commands: readonly Command[]): Promise<void> {
		await this.call("setWebhook", {
			url: webhookUrl,
			secret_token: secret,
			allowed_updates: JSON.stringify(["message", "callback_query", "poll", "stopped_message_generation"]),
		});
		await this.call("setMyCommands", { commands: JSON.stringify(commands) });
	}
}
