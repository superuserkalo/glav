import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { type AssistantMessage, type ImageContent, type Models, type ModelThinkingLevel, type TextContent, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	section,
	Harness,
	LiveDoc,
	type LiveState,
	type Storage,
	type Submission,
	type SubmissionId,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/** How many delivered request IDs and sent answers each chat remembers, to never send one twice. */
const REMEMBERED = 500;
/** Telegram keeps "typing" for 5 seconds and a draft for 30, so an unchanged one is sent again this often. */
const DRAFT_REFRESH_MS = 4000;
/** Telegram's limit for the caption of a voice message. */
const MAX_CAPTION = 1024;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const COMMANDS = [
	{ command: "new", description: "Start a fresh conversation" },
	{ command: "stop", description: "Stop what I am doing" },
	{ command: "model", description: "Show or change the model" },
	{ command: "thinking", description: "Show or change how hard I think" },
	{ command: "tts", description: "Voice mode: I answer with voice messages. On or off" },
	{ command: "compact", description: "Summarize older messages to free up context" },
	{ command: "usage", description: "Tokens and cost of this conversation" },
	{ command: "help", description: "List the commands" },
];

type ModelRef = { provider: string; modelId: string };

type ChatState = {
	conversationId: number;
	/** Request ID (Telegram update ID) to submission ID, for answers not yet sent to Telegram. */
	pending: Record<string, number>;
	delivered: string[];
	/** Answer entries already sent. Steered messages share the answer of the run they joined. */
	answers?: number[];
	/** Set with /model and /thinking; absent follows the process settings. */
	model?: ModelRef;
	thinking?: string;
	/** Set with /tts: answers are spoken, and what does not work in speech is sent as text beside them. */
	tts?: boolean;
};

const Bot = defineDoc<{ chats: Record<string, ChatState> }>({
	kind: "glav.bot",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});

/** A file of a message, saved by the transport. `error` says why there is no `path`. */
export type Attachment = {
	kind: "photo" | "voice" | "audio" | "document" | "video";
	path?: string;
	name: string;
	mime?: string;
	size?: number;
	error?: string;
};

type Inbound = { update_id: number; chat_id: number; text?: string; attachments?: Attachment[]; stop?: boolean };

export type AgentOptions = {
	storage: Storage;
	models: Models;
	provider: string;
	modelId: string;
	instructions: string;
	/** Base URL of the transport, which takes `/send`, `/draft` and `/commands`. */
	transportUrl: string;
	/**
	 * Shared with the transport and required on every request in both directions. Without it, anything that can reach
	 * this port, a web page in a browser on this machine included, could inject messages and so run commands.
	 */
	secret: string;
	host: string;
	port: number;
	/** Directory the agent works in with its file and shell tools. Absent: no tools. */
	workspace?: string;
	/** Turns a voice note or audio file into text. Absent: audio is handed over as a file. */
	transcribe?: (path: string, mime: string | undefined) => Promise<string>;
	/** Turns an answer into OGG Opus speech. Absent: no /tts. Needs a `workspace`, where the transport reads the file. */
	speak?: (text: string) => Promise<Uint8Array>;
	/** Longest pause between attempts to hand a reply to the transport. */
	maxSendWaitMs?: number;
	/** Shortest pause between two updates of a streamed draft. */
	draftIntervalMs?: number;
};

export type RunningAgent = {
	port: number;
	/** Stop taking messages and close the storage. Unfinished work stays pending for the next start. */
	close(): Promise<void>;
};

type Presenter = {
	conversation: Conversation;
	stop: () => Promise<unknown>;
	/** What the draft should show; undefined while the conversation is idle. */
	wanted?: { draftId: number; text: string };
	shown?: { draftId: number; text: string; at: number };
	pushing: boolean;
	timer?: NodeJS.Timeout;
	/** Tool call ID to what to show for it, because the tool round lists only names. */
	calls: Map<string, string>;
	live?: Readonly<LiveState> | null;
};

function textOf(message: Pick<AssistantMessage, "content"> | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Open the storage, pick up what the last process left, and serve `POST /inbound`. */
export async function startAgent(options: AgentOptions): Promise<RunningAgent> {
	const { models, transportUrl, workspace, transcribe } = options;
	const speak = workspace ? options.speak : undefined;
	const maxSendWaitMs = options.maxSendWaitMs ?? 60_000;
	const draftIntervalMs = options.draftIntervalMs ?? 1000;
	const context = BACKGROUND_CONTEXT;
	if (!options.secret) throw new Error("A shared secret is required");
	const authorization = Buffer.from(`Bearer ${options.secret}`);
	const defaultModel: ModelRef = { provider: options.provider, modelId: options.modelId };
	if (!models.getModel(defaultModel.provider, defaultModel.modelId)) {
		const known = models.getModels(defaultModel.provider).map((model) => model.id);
		throw new Error(
			`Unknown model ${defaultModel.provider}/${defaultModel.modelId}. Known: ${known.join(", ") || "none for this provider"}`,
		);
	}

	/** Conversation to chat, for tools that act on the chat they run in. */
	const chatOf = new Map<ConversationId, string>();

	/** What a conversation gets while its chat is in voice mode. */
	const Voice = defineExtension({
		name: "voice",
		sections: [
			section("voice", () =>
				[
					"Voice mode is on: your reply is read aloud to the user as a voice message, so write it the way you would say it.",
					"Use plain spoken sentences: no Markdown, no lists, no code, no file contents, no tables, no links, and nothing else that is awkward to hear. Keep it short.",
					"When there is material that does not work in speech, such as code, commands, command output, tables, long lists or links, do not read it out. Either send it with the send_text tool and say in your reply that you sent it as text, or, when the user may not need it, describe it briefly and ask whether they want it sent. When they say yes, send it with send_text.",
				].join("\n"),
			),
		],
		tools: [
			defineTool({
				name: "send_text",
				description:
					"Send the user a text message in this chat, beside your spoken reply. For what does not work in speech: code, commands, output, tables, long lists, links. Takes Markdown.",
				parameters: Type.Object({ markdown: Type.String({ description: "The message, formatted with Markdown" }) }),
				execute: async (args, api) => {
					const chatId = chatOf.get(api.conversationId);
					if (!chatId || !args.markdown.trim()) return { content: [{ type: "text", text: "Nothing was sent." }], isError: true };
					await inOrder(sends, chatId, () => send(chatId, args.markdown));
					return { content: [{ type: "text", text: "Sent. Mention in your spoken reply that you sent it as text." }] };
				},
			}),
		],
	});

	const registry = createRegistry();
	if (workspace) registry.install(CodingTools);
	if (speak) registry.install(Voice);
	const harness = await Harness.open(
		options.storage,
		{
			models,
			registry,
			// A message sent while the agent works joins that work instead of waiting for its answer.
			settings: { steeringMode: "all" },
			env: workspace ? ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }) : undefined,
		},
		context,
	);
	let closed = false;
	/** Cancelled at close, so deliveries stop waiting for answers and retries but still finish a send they started. */
	const waits = withCancel(context);

	/** Chats whose stored agent was already brought in line with this process's settings. */
	const configured = new Set<string>();
	/** Deliveries running in this process, by request ID. */
	const deliveries = new Map<string, Promise<void>>();
	const presenters = new Map<string, Presenter>();
	/** Per-chat tails, so admissions run in order, and so do sends. */
	const admissions = new Map<string, Promise<unknown>>();
	const sends = new Map<string, Promise<unknown>>();

	function inOrder<T>(chains: Map<string, Promise<unknown>>, chatId: string, work: () => Promise<T>): Promise<T> {
		const next = (chains.get(chatId) ?? Promise.resolve()).then(work, work);
		chains.set(chatId, next.catch(() => undefined));
		return next;
	}

	async function chatState(chatId: string): Promise<Readonly<ChatState> | undefined> {
		return (await harness.snapshot(Bot, context))?.chats[chatId];
	}

	function agentFor(state: Pick<ChatState, "model" | "thinking" | "tts"> | undefined) {
		return {
			// Every installed extension, and the voice one only in voice mode.
			extensions: state?.tts ? null : { remove: [Voice] },
			model: state?.model ?? defaultModel,
			thinkingLevel: (state?.thinking as ModelThinkingLevel | undefined) ?? null,
			instructions: options.instructions,
			cwd: workspace ?? null,
		};
	}

	async function conversationFor(chatId: string): Promise<Conversation> {
		const state = await chatState(chatId);
		let conversation: Conversation | undefined;
		if (!state) {
			configured.add(chatId);
			conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: agentFor(undefined),
					init: async (tx, conversationId) => {
						(await tx.doc(Bot)).chats[chatId] = { conversationId, pending: {}, delivered: [], answers: [] };
					},
				},
				context,
			);
		} else {
			conversation = await harness.conversation(state.conversationId as ConversationId, context);
			if (!conversation) throw new Error(`Chat ${chatId} points at missing conversation ${state.conversationId}`);
			if (!configured.has(chatId)) {
				await conversation.configure(agentFor(state), context);
				configured.add(chatId);
			}
		}
		chatOf.set(conversation.id, chatId);
		await present(chatId, conversation);
		return conversation;
	}

	async function modelOf(chatId: string) {
		const ref = (await chatState(chatId))?.model ?? defaultModel;
		return models.getModel(ref.provider, ref.modelId);
	}

	/** What a message brought, as model input: its text, images inline, and everything else by where it was saved. */
	async function contentOf(inbound: Inbound): Promise<string | (TextContent | ImageContent)[]> {
		const notes: string[] = [];
		const images: ImageContent[] = [];
		const seesImages = (await modelOf(String(inbound.chat_id)))?.input.includes("image") ?? false;
		for (const file of inbound.attachments ?? []) {
			if (!file.path) {
				notes.push(`[The user sent a ${file.kind} (${file.name}) that could not be received: ${file.error ?? "unknown error"}]`);
				continue;
			}
			const saved = `saved at ${file.path}`;
			if ((file.kind === "voice" || file.kind === "audio") && transcribe) {
				try {
					const transcript = (await transcribe(file.path, file.mime)).trim();
					notes.push(`[${file.kind === "voice" ? "Voice message" : `Audio file ${file.name}`}, transcribed] ${transcript}`);
					continue;
				} catch (error) {
					console.error(`transcribing ${file.path} failed:`, error);
				}
			}
			if (file.mime?.startsWith("image/") && seesImages) {
				images.push({ type: "image", data: (await readFile(file.path)).toString("base64"), mimeType: file.mime });
				notes.push(`[Image ${file.name}, ${saved}]`);
				continue;
			}
			notes.push(`[The user sent a ${file.kind}: ${file.name}, ${file.mime ?? "unknown type"}, ${file.size ?? "?"} bytes, ${saved}]`);
		}
		const text = [inbound.text, ...notes].filter(Boolean).join("\n\n");
		return images.length > 0 ? [{ type: "text", text }, ...images] : text;
	}

	/** Durably admit one Telegram message. Resolves once it is safe for the transport to confirm the update. */
	function admit(inbound: Inbound): Promise<void> {
		const chatId = String(inbound.chat_id);
		const requestId = String(inbound.update_id);
		return inOrder(admissions, chatId, async () => {
			const conversation = await conversationFor(chatId);
			// The same request ID returns the existing submission, so a re-forwarded update never runs twice.
			const submission = await conversation.submit(
				{ type: "input", content: await contentOf(inbound), requestId, whenBusy: "steer" },
				context,
			);
			const owed = await harness.commit(async (tx) => {
				const chat = (await tx.doc(Bot)).chats[chatId];
				if (!chat || chat.delivered.includes(requestId)) return false;
				chat.pending[requestId] = submission.id;
				return true;
			}, context);
			if (owed) deliver(chatId, requestId, submission);
		});
	}

	function deliver(chatId: string, requestId: string, submission: Submission): void {
		if (closed || deliveries.has(requestId)) return;
		const delivery = (async () => {
			try {
				const settled = await submission.wait(waits.context);
				await inOrder(sends, chatId, async () => {
					const answer = settled.status === "done" && settled.type === "input" ? settled.answer : undefined;
					let text: string | undefined;
					if (answer === undefined) {
						// An abort is the user's own stop, and they were told so.
						const reason = settled.status === "unanswered" ? settled.reason : "no answer";
						if (reason !== "aborted") text = `Sorry, I couldn't answer that (${reason}).`;
					} else if (!(await chatState(chatId))?.answers?.includes(answer)) {
						const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
						const message = entry?.model?.[0] as AssistantMessage | undefined;
						text = textOf(message).trim() || message?.errorMessage || "(empty reply)";
					}
					// In voice mode the answer is the voice message, with its words as the caption when they fit. The text
					// goes out as a message of its own when they do not, or when there is no voice message after all.
					const voiced = text !== undefined && answer !== undefined && (await chatState(chatId))?.tts && (await sendVoice(chatId, text, answer));
					if (text !== undefined && !(voiced && text.length <= MAX_CAPTION)) await send(chatId, text);
					await harness.commit(async (tx) => {
						const chat = (await tx.doc(Bot)).chats[chatId];
						if (!chat) return;
						delete chat.pending[requestId];
						remember(chat.delivered, requestId);
						if (answer !== undefined) remember((chat.answers ??= []), answer);
					}, context);
				});
			} catch (error) {
				// Stays pending in storage; the next start picks it up again.
				if (!closed) console.error(`delivery of ${requestId} to chat ${chatId} failed:`, error);
			} finally {
				deliveries.delete(requestId);
			}
		})();
		deliveries.set(requestId, delivery);
	}

	function remember<T>(list: T[], item: T): void {
		if (!list.includes(item)) list.push(item);
		if (list.length > REMEMBERED) list.splice(0, list.length - REMEMBERED);
	}

	function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
		return fetch(transportUrl + path, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: authorization.toString() },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	}

	/** Hand a reply to the transport, retrying until it is sent or the transport says it never can be. */
	async function send(chatId: string, text: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			if (closed) throw new Error("agent closed");
			let wait = Math.min(1000 * 2 ** attempt, maxSendWaitMs);
			try {
				const response = await post("/send", { chat_id: Number(chatId), text }, 120_000);
				if (response.ok) return;
				const detail = (await response.text()).trim();
				if (response.status === 422) {
					console.error(`chat ${chatId}: Telegram refused the reply for good, dropping it: ${detail}`);
					return;
				}
				const retryAfter = Number(response.headers.get("retry-after"));
				if (retryAfter > 0) wait = retryAfter * 1000;
				console.error(`chat ${chatId}: send failed with ${response.status} (${detail}), retrying in ${wait} ms`);
			} catch (error) {
				console.error(`chat ${chatId}: transport unreachable, retrying in ${wait} ms:`, error);
			}
			await awaitWithContext(new Promise((done) => setTimeout(done, wait)), waits.context);
		}
	}

	/** Best effort: false when there is no voice message, and the answer has to go out as text. */
	async function sendVoice(chatId: string, text: string, answer: number): Promise<boolean> {
		if (!speak || !workspace) return false;
		const path = join(workspace, "outbox", `${chatId}_${answer}.ogg`);
		try {
			await mkdir(join(workspace, "outbox"), { recursive: true });
			await writeFile(path, await speak(text));
			const caption = text.length <= MAX_CAPTION ? text : undefined;
			const response = await post("/voice", { chat_id: Number(chatId), path, caption }, 120_000);
			if (!response.ok) console.error(`chat ${chatId}: voice message refused with ${response.status}: ${(await response.text()).trim()}`);
			return response.ok;
		} catch (error) {
			console.error(`chat ${chatId}: voice message failed:`, error);
			return false;
		} finally {
			await rm(path, { force: true });
		}
	}

	/** A reply to a command. Not durable: a command repeated after a crash just runs again. */
	function say(chatId: string, text: string): void {
		void inOrder(sends, chatId, () => send(chatId, text)).catch(() => undefined);
	}

	/** Start showing a chat's work in progress as a streamed draft. */
	async function present(chatId: string, conversation: Conversation): Promise<void> {
		if (presenters.has(chatId)) return;
		const watch = await harness.watchDoc(LiveDoc, conversation.id, context);
		if (!watch) return;
		const presenter: Presenter = { conversation, stop: () => watch.stop(), pushing: false, calls: new Map() };
		presenters.set(chatId, presenter);
		const show = (live: Readonly<LiveState> | null) => {
			presenter.live = live;
			if (live?.tools?.some((slot) => !presenter.calls.has(slot.callId))) void describeCalls(presenter, show);
			presenter.wanted = live?.run
				? { draftId: live.run.inputs[0] ?? live.run.taskId, text: draftText(presenter, live) }
				: undefined;
			if (!presenter.wanted) {
				clearInterval(presenter.timer);
				presenter.timer = undefined;
				presenter.shown = undefined;
				presenter.calls.clear();
				return;
			}
			presenter.timer ??= setInterval(() => void pushDraft(chatId, presenter), draftIntervalMs);
			void pushDraft(chatId, presenter);
		};
		show(watch.value);
		watch.start(async (live) => show(live));
	}

	/** Read the calls of the current tool round from the transcript, then show the draft again with them. */
	async function describeCalls(presenter: Presenter, show: (live: Readonly<LiveState> | null) => void): Promise<void> {
		const { messages } = await presenter.conversation.context(context);
		const asking = messages.findLast((message) => message.role === "assistant");
		for (const part of asking?.content ?? []) {
			if (part.type !== "toolCall") continue;
			const detail = part.name === "bash" ? part.arguments?.command : part.arguments?.path;
			presenter.calls.set(part.id, typeof detail === "string" ? `${part.name}: \`${detail.slice(0, 200)}\`` : part.name);
		}
		// A call the transcript does not have either keeps its bare name.
		for (const slot of presenter.live?.tools ?? []) if (!presenter.calls.has(slot.callId)) presenter.calls.set(slot.callId, slot.name);
		if (presenter.live?.run) show(presenter.live);
	}

	/** The answer so far, and under it what the tools of the current round are doing. */
	function draftText(presenter: Presenter, live: Readonly<LiveState>): string {
		const message = live.generation?.message as AssistantMessage | undefined;
		const tools = (live.tools ?? [])
			.filter((slot) => slot.status !== "done")
			.map((slot) => `⚙️ ${presenter.calls.get(slot.callId) ?? slot.name}`);
		return [textOf(message).trim(), ...tools].filter(Boolean).join("\n\n");
	}

	/** Best effort: a draft that does not arrive is replaced by the next one, and by the answer in the end. */
	async function pushDraft(chatId: string, presenter: Presenter): Promise<void> {
		const { wanted, shown } = presenter;
		if (!wanted || presenter.pushing || closed) return;
		const now = Date.now();
		const changed = shown?.draftId !== wanted.draftId || shown.text !== wanted.text;
		if (shown && now - shown.at < (changed ? draftIntervalMs : DRAFT_REFRESH_MS)) return;
		presenter.pushing = true;
		presenter.shown = { ...wanted, at: now };
		try {
			await post("/draft", { chat_id: Number(chatId), draft_id: wanted.draftId, text: wanted.text }, 15_000);
		} catch {
			// The transport is down; the answer itself is retried.
		} finally {
			presenter.pushing = false;
		}
	}

	/** Keep a /model or /thinking choice for the chat and apply it from the next request on. */
	async function change(chatId: string, conversation: Conversation, choice: Pick<ChatState, "model" | "thinking" | "tts">): Promise<void> {
		const state = await harness.commit(async (tx) => {
			const chat = (await tx.doc(Bot)).chats[chatId]!;
			Object.assign(chat, choice);
			return { model: chat.model && { ...chat.model }, thinking: chat.thinking, tts: chat.tts };
		}, context);
		await conversation.configure(agentFor(state), context);
	}

	async function stop(chatId: string): Promise<void> {
		const state = await chatState(chatId);
		const conversation = state && (await harness.conversation(state.conversationId as ConversationId, context));
		if (!conversation) return;
		const busy = (await harness.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
		await conversation.abort(context);
		say(chatId, busy ? "Stopped." : "Nothing is running.");
	}

	/** Run a command. False when the text is not one of ours, so it goes to the model like any message. */
	async function command(chatId: string, text: string): Promise<boolean> {
		const match = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return false;
		const name = match[1]!;
		const arg = (match[2] ?? "").trim();
		if (name === "start" || name === "help") {
			say(chatId, ["Send me a message, photo, voice note or file.", "", ...COMMANDS.map((c) => `/${c.command} - ${c.description}`)].join("\n"));
			return true;
		}
		if (!COMMANDS.some((known) => known.command === name)) return false;
		if (name === "stop") {
			await stop(chatId);
			return true;
		}
		const conversation = await conversationFor(chatId);
		switch (name) {
			case "new":
				await conversation.abort(context);
				await conversation.reset(undefined, context);
				say(chatId, "Started a fresh conversation.");
				break;
			case "tts": {
				if (!speak) {
					say(chatId, "Voice answers are not set up.");
					break;
				}
				const on = arg === "on" || (arg === "" && !(await chatState(chatId))?.tts);
				if (arg !== "" && arg !== "on" && arg !== "off") {
					say(chatId, "Use /tts on or /tts off.");
					break;
				}
				await change(chatId, conversation, { tts: on });
				say(chatId, on ? "Voice mode on. I'll answer with voice messages, and send code and the like as text." : "Voice mode off.");
				break;
			}
			case "compact":
				await conversation.compact(arg || undefined, context);
				say(chatId, "Summarizing the older part of this conversation.");
				break;
			case "usage": {
				const usage = await harness.snapshot(UsageDoc, conversation.id, context);
				const lines = Object.entries(usage?.models ?? {}).map(
					([model, u]) => `${model}: ${u.input + u.cacheRead + u.cacheWrite} tokens in, ${u.output} out, $${u.cost.total.toFixed(4)}`,
				);
				say(chatId, lines.join("\n") || "Nothing used yet.");
				break;
			}
			case "model": {
				const current = (await chatState(chatId))?.model ?? defaultModel;
				if (!arg) {
					say(chatId, `Model: ${current.provider}/${current.modelId}\nChange it with /model <id> or /model <provider>/<id>.`);
					break;
				}
				const slash = arg.indexOf("/");
				const wanted =
					slash < 0 ? { provider: current.provider, modelId: arg } : { provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) };
				if (!models.getModel(wanted.provider, wanted.modelId)) {
					const known = models.getModels(wanted.provider).map((model) => model.id);
					say(chatId, `I don't know ${wanted.provider}/${wanted.modelId}.${known.length > 0 ? ` Models of ${wanted.provider}: ${known.join(", ")}` : ""}`);
					break;
				}
				await change(chatId, conversation, { model: wanted });
				say(chatId, `Model: ${wanted.provider}/${wanted.modelId}`);
				break;
			}
			case "thinking": {
				if (!arg) {
					say(chatId, `Thinking: ${(await conversation.agent(context)).thinkingLevel}\nLevels: ${THINKING_LEVELS.join(", ")}`);
					break;
				}
				if (!THINKING_LEVELS.includes(arg as ModelThinkingLevel)) {
					say(chatId, `Levels: ${THINKING_LEVELS.join(", ")}`);
					break;
				}
				await change(chatId, conversation, { thinking: arg });
				say(chatId, `Thinking: ${arg}`);
				break;
			}
		}
		return true;
	}

	/** Pick up answers the last process still owed to Telegram. */
	async function recover(): Promise<void> {
		const bot = await harness.snapshot(Bot, context);
		for (const [chatId, chat] of Object.entries(bot?.chats ?? {})) {
			const owed = Object.entries(chat.pending);
			if (owed.length > 0) await conversationFor(chatId);
			for (const [requestId, submissionId] of owed) {
				const submission = await harness.submission(submissionId as SubmissionId, context);
				if (submission) deliver(chatId, requestId, submission);
			}
		}
	}

	/** Publish the command menu once the transport is up. */
	async function publishCommands(): Promise<void> {
		for (let attempt = 0; attempt < 30 && !closed; attempt++) {
			try {
				if ((await post("/commands", COMMANDS, 15_000)).ok) return;
			} catch {
				// Not up yet.
			}
			await awaitWithContext(new Promise((done) => setTimeout(done, 2000)), waits.context);
		}
	}

	async function readJson(request: IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}

	function reply(response: ServerResponse, status: number, body: string): void {
		response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body);
	}

	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/inbound") return reply(response, 404, "not found");
		const given = Buffer.from(request.headers.authorization ?? "");
		if (given.length !== authorization.length || !timingSafeEqual(given, authorization)) return reply(response, 401, "unauthorized");
		let inbound: Inbound;
		try {
			inbound = (await readJson(request)) as Inbound;
		} catch {
			return reply(response, 400, "invalid JSON");
		}
		const { update_id, chat_id, text = "", attachments = [], stop: stopping } = inbound;
		const empty = typeof text !== "string" || !Array.isArray(attachments) || (text === "" && attachments.length === 0);
		if (!Number.isSafeInteger(update_id) || !Number.isSafeInteger(chat_id) || (!stopping && empty)) {
			return reply(response, 400, "expected integer update_id and chat_id, and text, attachments or stop");
		}
		try {
			const chatId = String(chat_id);
			if (stopping) await stop(chatId);
			else if (attachments.length > 0 || !(await command(chatId, text))) await admit(inbound);
			reply(response, 200, "ok");
		} catch (error) {
			console.error(`handling update ${update_id} failed:`, error);
			reply(response, 500, "could not store the message");
		}
	});

	harness.resume();
	await recover();
	await new Promise<void>((listening) => server.listen(options.port, options.host, listening));
	void publishCommands().catch(() => undefined);

	return {
		port: (server.address() as AddressInfo).port,
		async close() {
			if (closed) return;
			closed = true;
			server.close();
			server.closeAllConnections();
			waits.cancel();
			for (const presenter of presenters.values()) clearInterval(presenter.timer);
			await Promise.allSettled([...deliveries.values(), ...[...presenters.values()].map((presenter) => presenter.stop())]);
			await harness.close(context);
		},
	};
}
