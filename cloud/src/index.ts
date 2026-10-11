import { type Attachment, Chat, COMMANDS, type Env, type Inbound } from "./chat.ts";
import { Telegram } from "./telegram.ts";
import { isPoll, type Poll, Polls } from "./polls.ts";
import { Access, allowedUsers, type AccessSettings } from "./access.ts";
import { trialCodeIn, TrialLimitError, type Campaign } from "./trials.ts";

export { Chat };

type File = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
type Message = {
	message_id?: number;
	from?: { id: number; first_name?: string };
	chat?: { id: number };
	text?: string;
	caption?: string;
	photo?: File[];
	voice?: File;
	audio?: File;
	document?: File;
	video?: File;
	video_note?: File;
	poll?: Poll;
	reply_to_message?: { message_id?: number; poll?: Poll };
};
type Update = { update_id: number; message?: Message; poll?: Poll; callback_query?: { id: string; from?: { id: number }; message?: Message; data?: string }; stopped_message_generation?: { chat?: { id: number } } };

/** True when `given` is `wanted`, compared without leaking where they differ. An unset secret matches nothing. */
function same(given: string | null, wanted: string | undefined): boolean {
	if (!wanted) return false;
	const encoder = new TextEncoder();
	const a = encoder.encode(given ?? "");
	const b = encoder.encode(wanted);
	return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

function allowed(env: Env): Set<number> {
	return allowedUsers(env.ALLOWED_USERS);
}

/** What a message carries, the largest size of a photo only. */
function attachments(message: Message): Attachment[] {
	const list: Attachment[] = [];
	const add = (kind: Attachment["kind"], file: File | undefined, name: string, mime?: string) => {
		if (file) list.push({ kind, fileId: file.file_id, name: file.file_name ?? name, mime: mime ?? file.mime_type, size: file.file_size });
	};
	add("photo", message.photo?.at(-1), "photo.jpg", "image/jpeg");
	add("voice", message.voice, "voice.ogg");
	add("audio", message.audio, "audio.mp3");
	add("document", message.document, "file");
	add("video", message.video, "video.mp4");
	add("video", message.video_note, "video_note.mp4");
	return list;
}

/** Turn an update into what its chat should get, or nothing when it is not for the agent. */
async function route(update: Update, env: Env): Promise<Inbound | undefined> {
	const users = allowed(env);
	const access = new Access(env.DB, env);
	const privateAccess = async (userId: number, chatId: number) => userId === chatId && (await access.state(userId)).agent;
	const stopped = update.stopped_message_generation?.chat?.id;
	// Drafts exist only in private chats, where the chat ID is the user's ID.
	if (stopped !== undefined) return (access.deploymentMode === "self-hosted" ? users.has(stopped) : stopped > 0 || users.has(stopped)) ? { updateId: update.update_id, chatId: stopped, stop: true } : undefined;

	const callback = update.callback_query;
	if (callback) {
		const chatId = callback.message?.chat?.id;
		const messageId = callback.message?.message_id;
		const userId = callback.from?.id;
		if (chatId === undefined || messageId === undefined || userId === undefined) return undefined;
		if (!(users.has(userId) && users.has(chatId)) && !await privateAccess(userId, chatId)) return undefined;
		// Clear Telegram's progress indicator promptly. An expired query must not lose the user's choice.
		await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
		if (typeof callback.data !== "string" || callback.data === "") return undefined;
		const poll = isPoll(callback.message?.poll) ? { value: callback.message.poll, messageId } : undefined;
		return { updateId: update.update_id, chatId, callback: { messageId, userId, data: callback.data }, poll };
	}

	const message = update.message;
	if (!message?.chat || !message.from) return undefined;
	const privateChat = message.chat.id === message.from.id && message.from.id > 0;
	const trialCode = privateChat && access.deploymentMode === "hosted" ? trialCodeIn(message.text ?? message.caption) : undefined;
	const permanent = users.has(message.from.id) && users.has(message.chat.id);
	if (access.deploymentMode === "self-hosted" && !permanent) {
		if (privateChat) await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).call("sendMessage", { chat_id: String(message.chat.id), text: await access.denial(message.from.id) }).catch(() => undefined);
		return undefined;
	}
	const account = await access.state(message.from.id, message.chat.id);
	const active = account.agent;
	if (message.text?.trim() === "/stop" && (privateChat || permanent)) return { updateId: update.update_id, chatId: message.chat.id, stop: true };
	const redemption = privateChat && trialCode && await access.canRedeem(message.from.id, trialCode);
	if (privateChat && !active && trialCode && !redemption) {
		await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).call("sendMessage", { chat_id: String(message.chat.id), text: await access.trials.hasTrial(message.from.id)
			? "Your trial has ended or this campaign was already used. This code cannot activate another trial from the same campaign."
			: "This code cannot activate a trial. It may be invalid, expired, already redeemed, or its campaign has closed." }).catch(() => undefined);
		return undefined;
	}
	if (!permanent && !active && !redemption && !(privateChat && (account.freeRemaining > 0 || await access.freeTurn(message.from.id, update.update_id)))) {
		if (privateChat) {
			await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).call("sendMessage", { chat_id: String(message.chat.id), text: await access.denial(message.from.id) }).catch(() => undefined);
		}
		return undefined;
	}
	if (!active && !message.text && !message.caption && (attachments(message).length || message.poll)) {
		await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).call("sendMessage", { chat_id: String(message.chat.id), text: "Free access is text chat. Send your question as text, or activate a trial to use files and the full agent." }).catch(() => undefined);
		return undefined;
	}

	const source = message.poll ? message : message.reply_to_message;
	const poll = isPoll(source?.poll) ? { value: source.poll, messageId: source.message_id } : undefined;
	// Before activation, text reaches the model but downloads, transcriptions, polls, and computers cannot run.
	const inbound = { updateId: update.update_id, chatId: message.chat.id, text: message.text ?? message.caption,
		attachments: active ? attachments(message) : [], poll: active ? poll : undefined, trialCode, firstName: message.from.first_name };
	return inbound.text || inbound.attachments.length > 0 || inbound.poll ? inbound : undefined;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return new Response("not found", { status: 404 });

		if (url.pathname === "/telegram") {
			if (!same(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
			const update = (await request.json().catch(() => undefined)) as Update | undefined;
			if (!update || !Number.isSafeInteger(update.update_id)) return new Response("not an update", { status: 400 });
			if (isPoll(update.poll)) {
				const polls = new Polls(env.DB);
				const chatId = await polls.owner(update.poll.id);
				if (chatId !== undefined && (allowed(env).has(chatId) || chatId > 0 && (await new Access(env.DB, env).state(chatId)).agent)) await polls.update(update.poll, update.update_id);
				return new Response("ok");
			}
			const inbound = await route(update, env);
			// One object per chat. A failure answers 500, and Telegram sends the update again.
			if (inbound) await env.CHAT.get(env.CHAT.idFromName(String(inbound.chatId))).inbound(inbound);
			return new Response("ok");
		}

		// Only the operator can mint codes. Cleartext is returned once; D1 stores hashes.
		if (url.pathname === "/trial-codes") {
			if (!same(request.headers.get("authorization"), env.AGENT_SECRET && `Bearer ${env.AGENT_SECRET}`)) return new Response("unauthorized", { status: 401 });
			if (new Access(env.DB, env).deploymentMode === "self-hosted") return new Response("Commercial access controls are disabled in self-hosted deployments.", { status: 409 });
			const body = await request.json().catch(() => undefined) as { count?: number; validDays?: number; campaign?: string } | undefined;
			if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("expected JSON object", { status: 400 });
			const count = body.count ?? 1;
			const validDays = body.validDays ?? 7;
			if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(validDays) || validDays < 1 || validDays > 365) {
				return new Response("expected count 1-100 and validDays 1-365", { status: 400 });
			}
			try {
				const access = new Access(env.DB, env);
				if (!(await access.settings()).codesEnabled) return new Response("Trial codes are disabled", { status: 409 });
				if (body.campaign !== undefined && typeof body.campaign !== "string") return new Response("Invalid campaign", { status: 400 });
				return Response.json(await access.trials.issue(count, validDays, body.campaign), { headers: { "cache-control": "no-store" } });
			} catch (error) {
				if (error instanceof TrialLimitError) return Response.json({ error: error.message, limit: error.limit, remaining: error.remaining }, { status: 409, headers: { "cache-control": "no-store" } });
				if (error instanceof RangeError) return new Response(error.message, { status: 400 });
				throw error;
			}
		}

		// Operator controls do not run model calls or expose user data to conversations.
		if (["/access-settings", "/campaigns", "/waitlist", "/subscriptions"].includes(url.pathname)) {
			if (!same(request.headers.get("authorization"), env.AGENT_SECRET && `Bearer ${env.AGENT_SECRET}`)) return new Response("unauthorized", { status: 401 });
			if (new Access(env.DB, env).deploymentMode === "self-hosted") return new Response("Commercial access controls are disabled in self-hosted deployments.", { status: 409 });
			const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
			if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("expected JSON object", { status: 400 });
			const access = new Access(env.DB, env);
			try {
				const result = url.pathname === "/access-settings" ? await access.settings(body as Partial<AccessSettings>)
					: url.pathname === "/waitlist" ? await access.waitlist()
					: url.pathname === "/subscriptions" ? await access.subscription(body.userId as number, body.endsAt as number | undefined, body.reference as string | undefined)
					: await access.trials.configure((body.id ?? "launch") as string, Object.fromEntries(Object.entries(body).filter(([key]) => key !== "id")) as Partial<Campaign>);
				return Response.json(result, { headers: { "cache-control": "no-store" } });
			} catch (error) {
				if (error instanceof RangeError) return new Response(error.message, { status: 400 });
				throw error;
			}
		}

		// Run once after a deploy: points Telegram at this Worker and publishes the command menu.
		if (url.pathname === "/setup") {
			if (!same(request.headers.get("authorization"), env.AGENT_SECRET && `Bearer ${env.AGENT_SECRET}`)) return new Response("unauthorized", { status: 401 });
			await new Telegram(env.TELEGRAM_KEY, env.TELEGRAM_API).setUp(`${url.origin}/telegram`, env.WEBHOOK_SECRET, COMMANDS);
			return new Response(`webhook set to ${url.origin}/telegram`);
		}

		// For the operator: what each chat used over the last days, and the total.
		if (url.pathname === "/usage") {
			if (!same(request.headers.get("authorization"), env.AGENT_SECRET && `Bearer ${env.AGENT_SECRET}`)) return new Response("unauthorized", { status: 401 });
			const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 366);
			const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
			const sums = `SUM(messages) AS messages, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
				ROUND(SUM(model_cost_usd), 4) AS model_cost_usd, SUM(transcriptions) AS transcriptions, ROUND(SUM(computer_seconds)) AS computer_seconds`;
			try {
				const chats = await env.DB.prepare(`SELECT chat_id, ${sums} FROM usage WHERE day >= ? GROUP BY chat_id ORDER BY model_cost_usd DESC`).bind(since).all();
				const total = await env.DB.prepare(`SELECT COUNT(DISTINCT chat_id) AS chats, ${sums} FROM usage WHERE day >= ?`).bind(since).first();
				return Response.json({ since, total, chats: chats.results });
			} catch {
				// Nothing was reported yet, so the table does not exist.
				return Response.json({ since, total: null, chats: [] });
			}
		}

		// For the operator: the state of one chat.
		if (url.pathname === "/status" || url.pathname === "/cache" || url.pathname === "/snapshot-retention") {
			if (!same(request.headers.get("authorization"), env.AGENT_SECRET && `Bearer ${env.AGENT_SECRET}`)) return new Response("unauthorized", { status: 401 });
			const chatId = url.searchParams.get("chat") ?? "";
			if (!/^-?\d+$/.test(chatId)) return new Response("expected ?chat=<id>", { status: 400 });
			const chat = env.CHAT.get(env.CHAT.idFromName(chatId));
			if (url.pathname === "/snapshot-retention") {
				const body = await request.json().catch(() => null) as { renew?: boolean } | null;
				try {
					return Response.json(await chat.snapshotRetention(body?.renew === true));
				} catch (error) {
					// Worker and DO code updates propagate independently. An older instance may briefly lack this RPC method.
					if (error instanceof TypeError && error.message.includes('does not implement the method "snapshotRetention"')) return Response.json({ error: "Snapshot maintenance is still rolling out. Retry shortly." }, { status: 503, headers: { "retry-after": "60" } });
					throw error;
				}
			}
			return Response.json(url.pathname === "/cache" ? await chat.cacheStatus() : await chat.status());
		}

		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
