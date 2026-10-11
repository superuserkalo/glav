import { DurableObject } from "cloudflare:workers";

import { Files } from "@cloudflare/sandbox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type ImageContent, type ModelThinkingLevel, type TextContent, Type } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	type LiveState,
	type Submission,
	type SubmissionId,
	UsageDoc,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { type Command, Telegram, TelegramError } from "./telegram.ts";
import { TELEGRAM_PROMPT, telegramReplyNeeded, telegramRunDelivered, telegramTools } from "./telegram-tools.ts";
import { type Poll, Polls } from "./polls.ts";
import { Access, type AccessEnv } from "./access.ts";
import { trialTools } from "./trial-tools.ts";
import { OpenAICache } from "./openai-cache.ts";
import { pollContext } from "./poll-context.ts";

export type Env = AccessEnv & {
	CHAT: DurableObjectNamespace<Chat>;
	/** Usage, trial codes, and account entitlements. */
	DB: D1Database;
	TELEGRAM_KEY: string;
	OPENAI_API_KEY: string;
	ANTHROPIC_API_KEY?: string;
	/** Telegram sends it with every webhook call, so nothing else can pose as Telegram. */
	WEBHOOK_SECRET: string;
	/** Guards operator routes, including trial-code generation. */
	AGENT_SECRET?: string;
	/** Telegram IDs that may use the bot: users, and group chats they may use it in. Comma separated. */
	ALLOWED_USERS?: string;
	MODEL_PROVIDER?: string;
	MODEL_ID?: string;
	TRANSCRIBE_MODEL?: string;
	SYSTEM_PROMPT?: string;
	/** Only tests set these: another Bot API origin, and how fast the stand-in model writes. */
	TELEGRAM_API?: string;
	FAUX_TOKENS_PER_SECOND?: string;
};

/** A file of a message, by Telegram's reference to it. */
export type Attachment = { kind: "photo" | "voice" | "audio" | "document" | "video"; fileId: string; name: string; mime?: string; size?: number };

/** One Telegram update, as the Worker hands it over. */
export type Inbound = { updateId: number; chatId: number; text?: string; attachments?: Attachment[]; stop?: boolean; callback?: { messageId: number; userId: number; data: string }; poll?: { value: Poll; messageId?: number }; trialCode?: string; firstName?: string };

export const COMMANDS: readonly Command[] = [
	{ command: "new", description: "Start a fresh conversation" },
	{ command: "stop", description: "Stop what I am doing" },
	{ command: "model", description: "Show or change the model" },
	{ command: "thinking", description: "Show or change how hard I think" },
	{ command: "compact", description: "Summarize older messages to free up context" },
	{ command: "usage", description: "Tokens and cost of this conversation" },
	{ command: "help", description: "List the commands" },
];

/** How many delivered request IDs and sent answers the chat remembers, to never send one twice. */
const REMEMBERED = 500;
/** Telegram keeps "typing" for 5 seconds and a draft for 30, so an unchanged one is sent again this often. */
const DRAFT_REFRESH_MS = 4000;
const DRAFT_INTERVAL_MS = 1000;
/** While answers are owed, the object wakes itself this often, in case it was evicted in the middle of the work. */
const WATCHDOG_MS = 60_000;
/** A computer nobody uses for this long is stopped, and stops costing anything. */
const COMPUTER_IDLE_MS = 5 * 60_000;
const WORKSPACE = "/workspace";
/** How much of a command's output or a file the model is shown. */
const MAX_OUTPUT = 30_000;
const SNAPSHOT_KEY = "computer-snapshot";
/** What the chat used so far, what of it was already written to the database, and the computer's running session. */
const USAGE_KEY = "usage";
const REPORTED_KEY = "usage-reported";
const SESSION_KEY = "computer-session";
const START_KEY = "computer-last-start";
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_PROMPT =
	"You are Glav, an assistant chatting with users over Telegram. Keep replies short. Format with Markdown; Telegram renders it, tables and code blocks included.";
const COMPUTER_PROMPT = `You run in a Linux system with internet access. Use your tools to run shell commands and read, write, and edit files when needed. When asked to do something, do it with your tools instead of explaining how. Your working directory is ${WORKSPACE}, and files there are kept between conversations. Files the user sends are saved under ${WORKSPACE}/inbox.`;

type ChatState = {
	chatId: number;
	/** Request ID (Telegram update ID) to submission ID, for answers not yet sent to Telegram. */
	pending: Record<string, number>;
	delivered: string[];
	/** Answer entries already sent. Steered messages share the answer of the run they joined. */
	answers: number[];
	/** Set with /model and /thinking; absent follows the Worker's settings. */
	model?: string;
	thinking?: string;
	/** The code received from this account in a private Telegram message, also retained for tool recovery. */
	trialCode?: string;
	updateId?: number;
	firstName?: string;
	hasChatted?: boolean;
	introduction?: boolean;
};

const State = defineDoc<ChatState>({
	kind: "glav.chat",
	version: 1,
	scope: "session",
	initial: () => ({ chatId: 0, pending: {}, delivered: [], answers: [] }),
});

/** What a chat has used, in total. Model tokens and cost are kept by the conversation itself and added when reporting. */
type Counters = { messages: number; transcriptions: number; computerMs: number };
type Reported = Counters & { inputTokens: number; outputTokens: number; modelCost: number };
/** One stretch of the computer running. `countedMs` of it is already in the counters. */
type Session = { startedAt: number; lastUsedAt: number; countedMs: number };

const USAGE_TABLE = `CREATE TABLE IF NOT EXISTS usage (
	chat_id INTEGER NOT NULL, day TEXT NOT NULL,
	messages INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
	model_cost_usd REAL NOT NULL DEFAULT 0, transcriptions INTEGER NOT NULL DEFAULT 0, computer_seconds REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (chat_id, day))`;

const context = BACKGROUND_CONTEXT;

function textOf(message: Pick<AssistantMessage, "content"> | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function remember<T>(list: T[], item: T): void {
	if (!list.includes(item)) list.push(item);
	if (list.length > REMEMBERED) list.splice(0, list.length - REMEMBERED);
}

type Open = { harness: Harness; conversation: Conversation; models: MutableModels; provider: string; defaultModel: string; answerAs?: (text: string, trialCode?: string) => void };

/**
 * One chat: its conversation, in the object's own storage, and everything that shows it in Telegram. A chat is a
 * person's private chat or a group, so no two people's private conversations ever share an object.
 */
export class Chat extends DurableObject<Env> {
	private readonly telegram = new Telegram(this.env.TELEGRAM_KEY, this.env.TELEGRAM_API);
	private readonly polls = new Polls(this.env.DB);
	private readonly access = new Access(this.env.DB, this.env);
	private readonly trial = trialTools(this.access, async () => {
		const state = await (await this.open()).harness.snapshot(State, context);
		return { chatId: state?.chatId ?? 0, code: state?.trialCode, updateId: state?.updateId, firstName: state?.firstName, introduction: state?.introduction };
	});
	private readonly cache = new OpenAICache(this.ctx.storage);
	private opened?: Promise<Open>;
	/** Deliveries running in this incarnation, by request ID. */
	private readonly deliveries = new Map<string, Promise<void>>();
	/** Tail of what is sent to Telegram, so messages go out in order. */
	private sends: Promise<unknown> = Promise.resolve();
	private wanted?: { draftId: number; text: string };
	private shown?: { draftId: number; text: string; at: number };
	private pushing = false;
	/** Whether the computer was used since it was last saved. */
	private computerUsed = false;
	private timer?: ReturnType<typeof setInterval>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The idle timeout belongs to the object, not the container: a new incarnation that finds its computer running
		// has to set it again, or the computer would never be stopped.
		const container = ctx.container;
		if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(COMPUTER_IDLE_MS));
	}

	private open(): Promise<Open> {
		return (this.opened ??= (async () => {
			const provider = this.env.MODEL_PROVIDER ?? "openai";
			const models = createModels();
			let answerAs: Open["answerAs"];
			if (provider === "faux") {
				// A stand-in model for tests, which answers with what it was told to.
				const faux = fauxProvider({ provider, models: [{ id: "echo" }], tokensPerSecond: Number(this.env.FAUX_TOKENS_PER_SECOND) || undefined });
				models.setProvider(faux.provider);
				answerAs = (text, trialCode) => faux.appendResponses(trialCode ? [
					fauxAssistantMessage(fauxToolCall("activate_trial", { code: trialCode }), { stopReason: "toolUse" }),
					(transcript) => fauxAssistantMessage(`trial: ${JSON.stringify(transcript.messages.findLast((message) => message.role === "toolResult")?.content)}`),
				] : [fauxAssistantMessage(text)]);
			} else {
				models.setProvider(provider === "anthropic" ? anthropicProvider() : this.cache.wrap(openaiProvider()));
			}
			const registry = createRegistry();
			registry.install(this.trial.extension);
			registry.install(defineExtension({ name: "openai-cache", hooks: [hook(GenerationTask, { afterResponse: (message) => this.cache.record(message) })] }));
			if (this.ctx.container) registry.install(this.computerTools());
			const defaultModel = this.env.MODEL_ID ?? (provider === "faux" ? "echo" : "gpt-6-luna");
			const harness = await Harness.open(
				await openDurableObjectSqliteStorage(this.ctx.storage),
				// A message sent while the agent works joins that work instead of waiting for its answer.
				{ models, registry, settings: { steeringMode: "all" } },
				context,
			);
			registry.install(telegramTools(this.telegram, (work) => this.inOrder(async () => {
				const chatId = (await harness.snapshot(State, context))?.chatId;
				if (!chatId) throw new Error("No current Telegram chat.");
				return work(chatId);
			}), this.polls));
			const state = await harness.snapshot(State, context);
			const conversation = await harness.root(context);
			// Recover ownership of polls sent before poll tracking was installed, or before an interrupted registration.
			if (state?.chatId) {
				const history = await conversation.entries({}, 500, undefined, context);
				for (const entry of [...history.items].reverse()) {
					if (!ToolResultEntry.is(entry)) continue;
					const message = entry.model?.[0];
					if (message?.role !== "toolResult" || message.toolName !== "telegram" || message.isError) continue;
					for (const part of message.content) if (part.type === "text") {
						try { await this.polls.sent(state.chatId, JSON.parse(part.text)); } catch { /* An unrelated result is not a poll. */ }
					}
				}
			}
			await conversation.configure(await this.agent(provider, defaultModel, state), context);
			harness.resume();
			const watch = await harness.watchDoc(LiveDoc, conversation.id, context);
			if (watch) {
				this.present(watch.value);
				watch.start(async (live) => this.present(live));
			}
			return { harness, conversation, models, provider, defaultModel, answerAs };
		})());
	}

	private async agent(provider: string, defaultModel: string, state: Pick<ChatState, "chatId" | "model" | "thinking"> | undefined) {
		const active = state?.chatId ? (await this.access.state(state.chatId)).agent : false;
		return {
			model: { provider, modelId: active ? state?.model ?? defaultModel : defaultModel },
			thinkingLevel: active ? (state?.thinking as ModelThinkingLevel | undefined) ?? null : "off" as const,
			tools: active ? null : [this.trial.activate, this.trial.status],
			instructions: [this.env.SYSTEM_PROMPT ?? DEFAULT_PROMPT, ...(active ? [TELEGRAM_PROMPT, this.ctx.container ? COMPUTER_PROMPT : ""] : [])].filter(Boolean).join("\n"),
		};
	}

	/**
	 * This chat's computer, started on first use. It starts from the state it was last saved in, so the workspace
	 * outlives the container, which is stopped whenever it sits idle.
	 */
	private async computer(): Promise<Container> {
		const container = this.ctx.container;
		if (!container) throw new Error("This chat has no computer.");
		if (!container.running) {
			const snapshot = await this.ctx.storage.get<string>(SNAPSHOT_KEY);
			const options = { instance: "lite" as const, enableInternet: true };
			const began = Date.now();
			if (snapshot) container.start({ containerSnapshot: { id: snapshot }, ...options });
			else container.start({ image: container.images.sandbox!, ...options });
			await container.setInactivityTimeout(COMPUTER_IDLE_MS);
			// How long a start takes, measured to the first command that answers, for the operator's status.
			await (await container.exec(["true"])).output();
			await this.ctx.storage.put(START_KEY, { ms: Date.now() - began, from: snapshot ? "snapshot" : "image", at: new Date(began).toISOString() });
			// The stretch before this one ended when the computer was stopped for sitting idle.
			await this.settleComputerTime(false);
			await this.ctx.storage.put<Session>(SESSION_KEY, { startedAt: began, lastUsedAt: began, countedMs: 0 });
		}
		this.computerUsed = true;
		await this.touchComputer();
		return container;
	}

	/** Note that the computer was just used: it stays up for the idle time after this, and that time is paid for. */
	private async touchComputer(): Promise<void> {
		const session = await this.ctx.storage.get<Session>(SESSION_KEY);
		if (session) await this.ctx.storage.put<Session>(SESSION_KEY, { ...session, lastUsedAt: Date.now() });
	}

	/**
	 * Add the computer's running time that is not counted yet. There is no word of when an idle computer is stopped, so
	 * a stretch that has ended is taken to have lasted until the idle time after its last use.
	 */
	private async settleComputerTime(running: boolean): Promise<void> {
		const session = await this.ctx.storage.get<Session>(SESSION_KEY);
		if (!session) return;
		const end = running ? Date.now() : Math.min(Date.now(), session.lastUsedAt + COMPUTER_IDLE_MS);
		const lasted = Math.max(end - session.startedAt, 0);
		await this.count({ computerMs: Math.max(lasted - session.countedMs, 0) });
		if (running) await this.ctx.storage.put<Session>(SESSION_KEY, { ...session, countedMs: lasted });
		else await this.ctx.storage.delete(SESSION_KEY);
	}

	private async count(more: Partial<Counters>): Promise<void> {
		const usage = (await this.ctx.storage.get<Counters>(USAGE_KEY)) ?? { messages: 0, transcriptions: 0, computerMs: 0 };
		for (const [name, amount] of Object.entries(more) as [keyof Counters, number][]) usage[name] += amount;
		await this.ctx.storage.put(USAGE_KEY, usage);
	}

	/**
	 * Write what the chat used since the last report to the database, under today. Best effort: what cannot be written
	 * now stays unreported and goes out with the next report.
	 */
	private async reportUsage(open: Open): Promise<void> {
		try {
			await this.settleComputerTime(this.ctx.container?.running ?? false);
			const counters = (await this.ctx.storage.get<Counters>(USAGE_KEY)) ?? { messages: 0, transcriptions: 0, computerMs: 0 };
			const models = Object.values((await open.harness.snapshot(UsageDoc, open.conversation.id, context))?.models ?? {});
			const now: Reported = {
				...counters,
				inputTokens: models.reduce((sum, u) => sum + u.input + u.cacheRead + u.cacheWrite, 0),
				outputTokens: models.reduce((sum, u) => sum + u.output, 0),
				modelCost: models.reduce((sum, u) => sum + u.cost.total, 0),
			};
			const before = (await this.ctx.storage.get<Reported>(REPORTED_KEY)) ?? { messages: 0, transcriptions: 0, computerMs: 0, inputTokens: 0, outputTokens: 0, modelCost: 0 };
			const chatId = (await open.harness.snapshot(State, context))?.chatId;
			if (!chatId || (Object.keys(now) as (keyof Reported)[]).every((key) => now[key] === before[key])) return;
			await this.env.DB.batch([
				this.env.DB.prepare(USAGE_TABLE),
				this.env.DB.prepare(
					`INSERT INTO usage (chat_id, day, messages, input_tokens, output_tokens, model_cost_usd, transcriptions, computer_seconds)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (chat_id, day) DO UPDATE SET
						messages = messages + excluded.messages, input_tokens = input_tokens + excluded.input_tokens,
						output_tokens = output_tokens + excluded.output_tokens, model_cost_usd = model_cost_usd + excluded.model_cost_usd,
						transcriptions = transcriptions + excluded.transcriptions, computer_seconds = computer_seconds + excluded.computer_seconds`,
				).bind(
					chatId,
					new Date().toISOString().slice(0, 10),
					now.messages - before.messages,
					now.inputTokens - before.inputTokens,
					now.outputTokens - before.outputTokens,
					now.modelCost - before.modelCost,
					now.transcriptions - before.transcriptions,
					(now.computerMs - before.computerMs) / 1000,
				),
			]);
			await this.ctx.storage.put(REPORTED_KEY, now);
		} catch (error) {
			console.error(`reporting usage failed: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	}

	/** Save the computer's state, so the next container continues from here. */
	private async saveComputer(): Promise<void> {
		const container = this.ctx.container;
		if (!container?.running) return;
		try {
			const snapshot = await container.snapshotContainer({});
			await this.ctx.storage.put(SNAPSHOT_KEY, snapshot.id);
		} catch (error) {
			console.error(`saving the computer failed: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	}

	private computerTools() {
		const inWorkspace = (path: string) => (path.startsWith("/") ? path : `${WORKSPACE}/${path}`);
		const clip = (text: string) => (text.length > MAX_OUTPUT ? `[${text.length - MAX_OUTPUT} characters cut]\n${text.slice(-MAX_OUTPUT)}` : text);
		const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });
		return defineExtension({
			name: "computer",
			tools: [
				defineTool({
					name: "bash",
					description: `Run a shell command on your computer and get its output and exit code. Starts in ${WORKSPACE}; each call is a fresh shell.`,
					parameters: Type.Object({
						command: Type.String({ description: "The command, as you would type it in bash" }),
						timeout_seconds: Type.Optional(Type.Number({ description: "Stop the command after this long. Default 120." })),
					}),
					execute: async (args, _api, toolContext) => {
						const container = await this.computer();
						const limit = AbortSignal.timeout(Math.min(args.timeout_seconds ?? 120, 600) * 1000);
						const signal = toolContext.abortSignal ? AbortSignal.any([limit, toolContext.abortSignal]) : limit;
						const process = await container.exec(["/bin/bash", "-lc", args.command], { cwd: WORKSPACE, stderr: "combined", signal });
						const output = await process.output();
						await this.touchComputer();
						return text(`exit code ${output.exitCode}\n${clip(new TextDecoder().decode(output.stdout))}`);
					},
				}),
				defineTool({
					name: "read_file",
					description: `Read a text file from your computer. Relative paths are under ${WORKSPACE}.`,
					parameters: Type.Object({ path: Type.String() }),
					replay: "safe",
					execute: async (args) => {
						const response = await new Files(await this.computer()).readFile(inWorkspace(args.path));
						return text(clip(await response.text()));
					},
				}),
				defineTool({
					name: "write_file",
					description: `Write a text file on your computer, replacing it if it exists. Relative paths are under ${WORKSPACE}.`,
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
					replay: "safe",
					execute: async (args) => {
						const path = inWorkspace(args.path);
						const files = new Files(await this.computer());
						await files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
						await files.writeFile(path, args.content);
						return text(`Wrote ${path}.`);
					},
				}),
			],
		});
	}

	/** Durably take one update. Resolving tells Telegram it need not send it again. */
	async inbound(inbound: Inbound): Promise<void> {
		const open = await this.open();
		const { harness, conversation } = open;
		if (inbound.stop) return this.stop(open);
		const active = (await this.access.state(inbound.chatId)).agent;
		const redemption = inbound.trialCode && await this.access.canRedeem(inbound.chatId, inbound.trialCode);
		if (!active && !redemption && !await this.access.freeTurn(inbound.chatId, inbound.updateId, true)) {
			this.say(open, await this.access.denial(inbound.chatId));
			return;
		}
		// An over-quota request must not replace the identity of a legitimate turn still generating.
		const state = await harness.commit(async (tx) => {
			const doc = await tx.doc(State);
			const delivered = doc.delivered.includes(String(inbound.updateId));
			if (!delivered) {
				doc.chatId = inbound.chatId;
				if (doc.updateId !== inbound.updateId) {
					doc.introduction = !doc.hasChatted && doc.delivered.length === 0;
					doc.hasChatted = true;
				}
				doc.updateId = inbound.updateId;
				if (inbound.firstName) doc.firstName = inbound.firstName;
				if (inbound.trialCode) doc.trialCode = inbound.trialCode;
			}
			return { delivered };
		}, context);
		if (state.delivered) return;
		if (!active) await this.access.joinWaitlist(inbound.chatId);
		await conversation.configure(await this.agent(open.provider, open.defaultModel, await harness.snapshot(State, context)), context);
		const text = inbound.text ?? "";
		if ((active || /^\/(new|stop|help)(?:\s|$)/.test(text)) && !inbound.callback && !inbound.poll && !inbound.attachments?.length && (await this.command(open, text, active))) return;

		const requestId = String(inbound.updateId);
		const content = active ? await this.contentOf(open, inbound) : text;
		if (open.answerAs) open.answerAs(`echo: ${typeof content === "string" ? content : textOf({ content: content as AssistantMessage["content"] })}`, inbound.trialCode);
		// The same request ID returns the existing submission, so an update Telegram sends again never runs twice.
		const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: "steer" }, context);
		const fresh = await harness.commit(async (tx) => {
			const doc = await tx.doc(State);
			const fresh = !(requestId in doc.pending);
			doc.pending[requestId] = submission.id;
			return fresh;
		}, context);
		if (fresh) await this.count({ messages: 1 });
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
		this.deliver(open, requestId, submission);
	}

	/** Cache accounting alone, without opening the conversation or returning its content. */
	async cacheStatus() {
		return this.cache.report();
	}

	/** What an operator needs to see when a chat misbehaves: what is owed, what is running, and the latest entries. */
	async status(): Promise<Record<string, unknown>> {
		const { harness, conversation } = await this.open();
		const state = await harness.snapshot(State, context);
		const live = await harness.snapshot(LiveDoc, conversation.id, context);
		const page = await conversation.entries({}, 8, undefined, context);
		return {
			chatId: state?.chatId,
			pending: Object.keys(state?.pending ?? {}),
			delivered: state?.delivered.length,
			running: live?.run !== undefined,
			tools: live?.tools?.map((slot) => `${slot.name}:${slot.status}`),
			retry: live?.generation?.retry,
			computer: { attached: this.ctx.container !== undefined, running: this.ctx.container?.running, snapshot: await this.ctx.storage.get<string>(SNAPSHOT_KEY), lastStart: await this.ctx.storage.get(START_KEY) },
			polls: state?.chatId ? await this.polls.current(state.chatId) : [],
			trial: state?.chatId ? await this.access.trials.access(state.chatId) ?? null : null,
			access: state?.chatId ? await this.access.state(state.chatId) : null,
			cache: await this.cache.report(),
			entries: page.items.map((entry) => `${entry.kind}: ${JSON.stringify(entry.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : "").slice(0, 300)}`),
		};
	}

	/** Wakes the object while answers are owed: unfinished runs continue, and unsent answers are sent. */
	async alarm(): Promise<void> {
		const open = await this.open();
		const state = await open.harness.snapshot(State, context);
		const owed = Object.entries(state?.pending ?? {});
		for (const [requestId, submissionId] of owed) {
			const submission = await open.harness.submission(submissionId as SubmissionId, context);
			if (submission) this.deliver(open, requestId, submission);
		}
		if (owed.length > 0) return void (await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS));
		// Nothing is owed any more. Once the computer has had time to go idle and stop, its last stretch is reported.
		const session = await this.ctx.storage.get<Session>(SESSION_KEY);
		if (!session) return;
		const stopsAt = session.lastUsedAt + COMPUTER_IDLE_MS;
		if (Date.now() < stopsAt || this.ctx.container?.running) return void (await this.ctx.storage.setAlarm(Math.max(stopsAt, Date.now()) + WATCHDOG_MS));
		await this.reportUsage(open);
	}

	/** What a message brought, as model input: its text, images inline, speech as text. */
	private async contentOf(open: Open, inbound: Inbound): Promise<string | (TextContent | ImageContent)[]> {
		const notes: string[] = [];
		if (inbound.callback) notes.push(`[Telegram button click] ${JSON.stringify({ message_id: inbound.callback.messageId, user_id: inbound.callback.userId, data: inbound.callback.data })}`);
		const images: ImageContent[] = [];
		const state = await open.harness.snapshot(State, context);
		if (inbound.poll) {
			// Embedded Message.poll can be an old snapshot. Only a dedicated poll update refreshes totals.
			await this.polls.remember(inbound.chatId, inbound.poll.messageId, inbound.poll.value);
		}
		const polls = await this.polls.current(inbound.chatId);
		if (polls.length) {
			const note = pollContext(polls, (await open.conversation.context(context)).messages);
			if (note) notes.push(note);
		}
		const seesImages = open.models.getModel(open.provider, state?.model ?? open.defaultModel)?.input.includes("image") ?? false;
		for (const file of inbound.attachments ?? []) {
			try {
				if (file.kind === "voice" || file.kind === "audio") {
					const transcript = await this.transcribe(await this.telegram.download(file.fileId), file.mime ?? "audio/ogg", file.name);
					await this.count({ transcriptions: 1 });
					notes.push(`[${file.kind === "voice" ? "Voice message" : `Audio file ${file.name}`}, transcribed] ${transcript.trim()}`);
				} else if (file.mime?.startsWith("image/") && seesImages) {
					const bytes = await this.telegram.download(file.fileId);
					images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: file.mime });
					notes.push(`[Image ${file.name}]`);
				} else if (this.ctx.container) {
					// Any other file goes onto the chat's computer, where the model's tools can open it.
					const path = `${WORKSPACE}/inbox/${inbound.updateId}_${file.name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
					const files = new Files(await this.computer());
					await files.mkdir(`${WORKSPACE}/inbox`, { recursive: true });
					await files.writeFile(path, await this.telegram.download(file.fileId));
					notes.push(`[The user sent a ${file.kind}: ${file.name}, ${file.mime ?? "unknown type"}, saved on your computer at ${path}]`);
				} else {
					notes.push(`[The user sent a ${file.kind}: ${file.name}, ${file.mime ?? "unknown type"}, ${file.size ?? "?"} bytes. You have nowhere to open it.]`);
				}
			} catch (error) {
				// A file Telegram will never hand out must not hold the message back; anything else is tried again.
				if (!(error instanceof TelegramError) || !error.permanent) throw error;
				notes.push(`[The user sent a ${file.kind} (${file.name}) that could not be received: ${error.message}]`);
			}
		}
		const text = [inbound.text, ...notes].filter(Boolean).join("\n\n");
		return images.length > 0 ? [{ type: "text", text }, ...images] : text;
	}

	/** Speech to text through OpenAI, which takes Telegram's OGG voice notes as they are. */
	private async transcribe(audio: Uint8Array, mime: string, name: string): Promise<string> {
		if (this.env.MODEL_PROVIDER === "faux") return `transcript of ${audio.length} bytes`;
		const form = new FormData();
		form.set("model", this.env.TRANSCRIBE_MODEL ?? "gpt-transcribe");
		form.set("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime }), name);
		const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: { authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
			body: form,
		});
		if (!response.ok) throw new Error(`transcription failed with ${response.status}`);
		return ((await response.json()) as { text: string }).text;
	}

	private deliver(open: Open, requestId: string, submission: Submission): void {
		if (this.deliveries.has(requestId)) return;
		const delivery = (async () => {
			try {
				const settled = await submission.wait(context);
				await this.inOrder(async () => {
					const answer = settled.status === "done" && settled.type === "input" ? settled.answer : undefined;
					const state = await open.harness.snapshot(State, context);
					let text: string | undefined;
					if (answer === undefined) {
						// An abort is the user's own stop, and they were told so.
						const reason = settled.status === "unanswered" ? settled.reason : "no answer";
						if (reason !== "aborted") text = `Sorry, I couldn't answer that (${reason}).`;
					} else if (!state?.answers.includes(answer) && await telegramReplyNeeded(open.harness, state?.pending ?? {}, settled, context)) {
						const entry = await open.harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
						const message = entry?.model?.[0] as AssistantMessage | undefined;
						text = textOf(message).trim() || message?.errorMessage || "(empty reply)";
					}
					if (text !== undefined && state) await this.send(state.chatId, text);
					await open.harness.commit(async (tx) => {
						const doc = await tx.doc(State);
						delete doc.pending[requestId];
						remember(doc.delivered, requestId);
						if (answer !== undefined) remember(doc.answers, answer);
					}, context);
				});
				await this.reportUsage(open);
			} catch (error) {
				// Stays pending in storage; the alarm picks it up again.
				console.error(`delivery of ${requestId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
			} finally {
				this.deliveries.delete(requestId);
			}
		})();
		this.deliveries.set(requestId, delivery);
		// Keeps the object in memory until the answer is out.
		this.ctx.waitUntil(delivery);
	}

	private inOrder<T>(work: () => Promise<T>): Promise<T> {
		const next = this.sends.then(work, work);
		this.sends = next.catch(() => undefined);
		return next;
	}

	/** Send a reply, trying a few times. One Telegram refuses for good is dropped; any other failure is the caller's to retry. */
	private async send(chatId: number, text: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.telegram.send(chatId, text);
			} catch (error) {
				if (error instanceof TelegramError && error.permanent) {
					console.error(`Telegram refused a reply for good, dropping it: ${error.message}`);
					return;
				}
				const wait = error instanceof TelegramError && error.retryAfter > 0 ? error.retryAfter * 1000 : 1000 * 2 ** attempt;
				if (attempt >= 3 || wait > 30_000) throw error;
				await new Promise((done) => setTimeout(done, wait));
			}
		}
	}

	/** A reply to a command. Not durable: a command Telegram sends again just runs again. */
	private say(open: Open, text: string): void {
		const said = this.inOrder(async () => {
			const chatId = (await open.harness.snapshot(State, context))?.chatId;
			if (chatId) await this.send(chatId, text);
		}).catch((error) => console.error(`a command's reply failed: ${error instanceof Error ? error.message : "unknown error"}`));
		this.ctx.waitUntil(said);
	}

	/** Show the conversation's work in progress as a streamed draft. */
	private present(live: Readonly<LiveState> | null): void {
		if (!live?.run) {
			clearInterval(this.timer);
			this.timer = this.wanted = this.shown = undefined;
			// The work is done: keep what it left on the computer.
			if (this.computerUsed) {
				this.computerUsed = false;
				this.ctx.waitUntil(this.saveComputer());
			}
			return;
		}
		const tools = (live.tools ?? []).filter((slot) => slot.status !== "done").map((slot) => `⚙️ ${slot.name}`);
		const text = [textOf(live.generation?.message as AssistantMessage | undefined).trim(), ...tools].filter(Boolean).join("\n\n");
		this.wanted = { draftId: live.run.inputs[0] ?? live.run.taskId, text };
		this.timer ??= setInterval(() => void this.pushDraft(), DRAFT_INTERVAL_MS);
		void this.pushDraft();
	}

	/** Best effort: a draft that does not arrive is replaced by the next one, and by the answer in the end. */
	private async pushDraft(): Promise<void> {
		const { wanted, shown } = this;
		if (!wanted || this.pushing) return;
		const now = Date.now();
		const changed = shown?.draftId !== wanted.draftId || shown.text !== wanted.text;
		if (shown && now - shown.at < (changed ? DRAFT_INTERVAL_MS : DRAFT_REFRESH_MS)) return;
		this.pushing = true;
		this.shown = { ...wanted, at: now };
		try {
			await this.inOrder(async () => {
				const { harness, conversation } = await this.open();
				const live = await harness.snapshot(LiveDoc, conversation.id, context);
				if (wanted !== this.wanted || !live?.run) return;
				if (await telegramRunDelivered(harness, conversation.id, live.run.inputs, context)) {
					clearInterval(this.timer);
					this.timer = this.wanted = this.shown = undefined;
					return;
				}
				const chatId = (await harness.snapshot(State, context))?.chatId;
				if (chatId) await this.telegram.draft(chatId, wanted.draftId, wanted.text);
			});
		} catch {
			// The answer itself is retried.
		} finally {
			this.pushing = false;
		}
	}

	private async stop(open: Open): Promise<void> {
		const busy = (await open.harness.snapshot(LiveDoc, open.conversation.id, context))?.run !== undefined;
		await open.conversation.abort(context);
		this.say(open, busy ? "Stopped." : "Nothing is running.");
	}

	/** Keep a /model or /thinking choice and apply it from the next request on. */
	private async change(open: Open, choice: Pick<ChatState, "model" | "thinking">): Promise<void> {
		const state = await open.harness.commit(async (tx) => {
			const doc = await tx.doc(State);
			Object.assign(doc, choice);
			return { chatId: doc.chatId, model: doc.model, thinking: doc.thinking };
		}, context);
		await open.conversation.configure(await this.agent(open.provider, open.defaultModel, state), context);
	}

	/** Run a command. False when the text is not one of ours, so it goes to the model like any message. */
	private async command(open: Open, text: string, active: boolean): Promise<boolean> {
		const match = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return false;
		const name = match[1]!;
		const arg = (match[2] ?? "").trim();
		const { conversation, harness, models, provider } = open;
		switch (name) {
			case "start":
			case "help":
				this.say(open, active ? ["Send me a message, photo or voice note.", "", ...COMMANDS.map((c) => `/${c.command} - ${c.description}`)].join("\n")
					: "Free access is text chat. A trial or subscription unlocks the full agent. /new starts a fresh conversation; /stop stops a reply. Your free allowance does not reset.");
				return true;
			case "stop":
				await this.stop(open);
				return true;
			case "new":
				await conversation.abort(context);
				await conversation.reset(undefined, context);
				this.say(open, "Started a fresh conversation.");
				return true;
			case "compact":
				await conversation.compact(arg || undefined, context);
				this.say(open, "Summarizing the older part of this conversation.");
				return true;
			case "usage": {
				const usage = await harness.snapshot(UsageDoc, conversation.id, context);
				const lines = Object.entries(usage?.models ?? {}).map(
					([model, u]) => `${model}: ${u.input + u.cacheRead + u.cacheWrite} tokens in, ${u.output} out, $${u.cost.total.toFixed(4)}`,
				);
				this.say(open, lines.join("\n") || "Nothing used yet.");
				return true;
			}
			case "model": {
				const current = (await harness.snapshot(State, context))?.model ?? open.defaultModel;
				if (!arg) {
					this.say(open, `Model: ${current}\nChange it with /model <id>.`);
				} else if (!models.getModel(provider, arg)) {
					this.say(open, `I don't know ${arg}. Models: ${models.getModels(provider).map((model) => model.id).join(", ")}`);
				} else {
					await this.change(open, { model: arg });
					this.say(open, `Model: ${arg}`);
				}
				return true;
			}
			case "thinking": {
				if (!arg) {
					this.say(open, `Thinking: ${(await conversation.agent(context)).thinkingLevel}\nLevels: ${THINKING_LEVELS.join(", ")}`);
				} else if (!THINKING_LEVELS.includes(arg as ModelThinkingLevel)) {
					this.say(open, `Levels: ${THINKING_LEVELS.join(", ")}`);
				} else {
					await this.change(open, { thinking: arg });
					this.say(open, `Thinking: ${arg}`);
				}
				return true;
			}
			default:
				return false;
		}
	}
}
