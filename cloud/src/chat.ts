import { DurableObject } from "cloudflare:workers";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type Conversation, createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, LiveDoc, UsageDoc, ToolResultEntry } from "@earendil-works/pi-durable";
import { ConversationRuntime, type ConversationState, type ModelRef, textOf } from "./runtime/conversation.ts";
import { computerPrompt, computerTools, DEFAULT_PROMPT } from "./runtime/computer.ts";
import { inputContent, type InputContent } from "./runtime/content.ts";
import { SandboxComputer } from "./computer.ts";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { Telegram, TelegramError } from "./telegram.ts";
import { TELEGRAM_PROMPT, telegramReplyNeeded, telegramRunDelivered, telegramTools } from "./telegram-tools.ts";
import { type Poll, Polls } from "./polls.ts";
import { Access, type AccessEnv } from "./access.ts";
import { trialTools } from "./trial-tools.ts";
import { OpenAICache } from "./openai-cache.ts";
import { pollContext } from "./poll-context.ts";
import { SNAPSHOT_KEY, SnapshotRenewal } from "./snapshot-renewal.ts";

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

export { COMMANDS } from "./runtime/conversation.ts";
const WATCHDOG_MS = 60_000;
const USAGE_KEY = "usage";
const REPORTED_KEY = "usage-reported";

type ChatState = {
	chatId: number;
	/** Request ID (Telegram update ID) to submission ID, for answers not yet sent to Telegram. */
	pending: Record<string, number>;
	delivered: string[];
	/** Answer entries already sent. Steered messages share the answer of the run they joined. */
	answers: number[];
	/** Set with /model and /thinking; absent follows the Worker's settings. */
	model?: string | ModelRef;
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

const USAGE_TABLE = `CREATE TABLE IF NOT EXISTS usage (
	chat_id INTEGER NOT NULL, day TEXT NOT NULL,
	messages INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
	model_cost_usd REAL NOT NULL DEFAULT 0, transcriptions INTEGER NOT NULL DEFAULT 0, computer_seconds REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (chat_id, day))`;

const context = BACKGROUND_CONTEXT;

type Open = { runtime: ConversationRuntime; harness: Harness; conversation: Conversation; models: MutableModels; provider: string; defaultModel: string; answerAs?: (text: string, trialCode?: string) => void };

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
	private readonly snapshots = new SnapshotRenewal(this.ctx.storage, this.ctx.container);
	private opened?: Promise<Open>;
	private readonly machine = this.ctx.container ? new SandboxComputer(this.ctx, (computerMs) => this.count({ computerMs }), this.snapshots) : undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(() => this.snapshots.initialize());
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
			if (this.machine) registry.install(computerTools(this.machine));
			const defaultModel = this.env.MODEL_ID ?? (provider === "faux" ? "echo" : "gpt-6-luna");
			const harness = await Harness.open(
				await openDurableObjectSqliteStorage(this.ctx.storage),
				// A message sent while the agent works joins that work instead of waiting for its answer.
				{ models, registry, settings: { steeringMode: "all" } },
				context,
			);
			let runtime: ConversationRuntime;
			registry.install(telegramTools(this.telegram, (work) => runtime.inOrder(async () => {
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
			runtime = new ConversationRuntime({
				harness, conversation, models, defaultModel: { provider, modelId: defaultModel },
				state: {
					read: async () => this.runtimeState(await harness.snapshot(State, context), provider),
					update: async (change) => { await harness.commit(async (tx) => {
						const doc = await tx.doc(State);
						const state = this.runtimeState(doc, provider)!;
						change(state);
						Object.assign(doc, state);
					}, context); },
				},
				configure: async (state) => this.agent(provider, defaultModel, { ...state, chatId: (await harness.snapshot(State, context))?.chatId ?? 0 }),
				transport: {
					send: async (text) => { const id = (await harness.snapshot(State, context))?.chatId; if (!id) throw new Error("No current Telegram chat."); await this.send(id, text); },
					draft: async (id, text) => { const chatId = (await harness.snapshot(State, context))?.chatId; if (chatId) await this.telegram.draft(chatId, id, text); },
				},
				keepAlive: (work) => this.ctx.waitUntil(work),
				onPending: async (fresh) => { if (fresh) await this.count({ messages: 1 }); await this.snapshots.scheduleWork(Date.now() + WATCHDOG_MS); },
				onDelivered: () => this.reportUsage(open),
				onIdle: async () => this.machine?.saveIfUsed(),
				replyNeeded: (pending, settled) => telegramReplyNeeded(harness, pending, settled, context),
				draftNeeded: async (inputs) => !await telegramRunDelivered(harness, conversation.id, inputs, context),
			});
			const open: Open = { runtime, harness, conversation, models, provider, defaultModel, answerAs };
			await runtime.start();
			harness.resume();
			await runtime.recover();
			return open;
		})());
	}

	private runtimeState(state: Readonly<ChatState> | undefined, provider: string): ConversationState | undefined {
		if (!state) return;
		return { pending: { ...state.pending }, delivered: [...state.delivered], answers: [...state.answers], model: typeof state.model === "string" ? { provider, modelId: state.model } : state.model, thinking: state.thinking };
	}

	private async agent(provider: string, defaultModel: string, state: Pick<ChatState, "chatId" | "model" | "thinking"> | undefined) {
		const active = state?.chatId ? (await this.access.state(state.chatId)).agent : false;
		return {
			model: active ? (typeof state?.model === "string" ? { provider, modelId: state.model } : state?.model) ?? { provider, modelId: defaultModel } : { provider, modelId: defaultModel },
			thinkingLevel: active ? (state?.thinking as ModelThinkingLevel | undefined) ?? null : "off" as const,
			tools: active ? null : [this.trial.activate, this.trial.status],
			instructions: [this.env.SYSTEM_PROMPT ?? DEFAULT_PROMPT, ...(active ? [TELEGRAM_PROMPT, this.machine ? computerPrompt(this.machine) : ""] : [])].filter(Boolean).join("\n"),
		};
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
			await this.machine?.settle();
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

	/** Durably take one update. Resolving tells Telegram it need not send it again. */
	async inbound(inbound: Inbound): Promise<void> {
		const open = await this.open();
		const { harness, conversation } = open;
		if (inbound.stop) return open.runtime.stop();
		const active = (await this.access.state(inbound.chatId)).agent;
		const redemption = inbound.trialCode && await this.access.canRedeem(inbound.chatId, inbound.trialCode);
		if (!active && !redemption && !await this.access.freeTurn(inbound.chatId, inbound.updateId, true)) {
			open.runtime.say(await this.access.denial(inbound.chatId));
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
		await open.runtime.configure();
		const text = inbound.text ?? "";
		if ((active || /^\/(new|stop|help)(?:\s|$)/.test(text)) && !inbound.callback && !inbound.poll && !inbound.attachments?.length && (await open.runtime.command(text, active ? undefined : "Free access is text chat. A trial or subscription unlocks the full agent. /new starts a fresh conversation; /stop stops a reply. Your free allowance does not reset."))) return;

		await open.runtime.admit(String(inbound.updateId), async () => {
			const content = active ? await this.contentOf(open, inbound) : text;
			open.answerAs?.(`echo: ${typeof content === "string" ? content : textOf({ content })}`, inbound.trialCode);
			return content;
		});
	}

	/** Cache accounting alone, without opening the conversation or returning its content. */
	async cacheStatus() {
		return this.cache.report();
	}

	/** Operator maintenance without opening the conversation or sending anything to Telegram. */
	async snapshotRetention(renew = false) {
		if (renew) await this.snapshots.renewIfDue(true);
		return { attached: this.ctx.container !== undefined, running: this.ctx.container?.running, snapshot: await this.ctx.storage.get<string>(SNAPSHOT_KEY), retention: await this.snapshots.status() };
	}

	/** What an operator needs to see when a chat misbehaves: what is owed, what is running, and the latest entries. */
	async status(): Promise<Record<string, unknown>> {
		const { harness, conversation } = await this.open();
		const state = await harness.snapshot(State, context);
		const live = await harness.snapshot(LiveDoc, conversation.id, context);
		const page = await conversation.entries({}, 8, undefined, context);
		const access = state?.chatId ? await this.access.state(state.chatId) : null;
		return {
			chatId: state?.chatId,
			pending: Object.keys(state?.pending ?? {}),
			delivered: state?.delivered.length,
			running: live?.run !== undefined,
			tools: live?.tools?.map((slot) => `${slot.name}:${slot.status}`),
			retry: live?.generation?.retry,
			computer: { ...(this.machine ? await this.machine.status() : { attached: false, running: false }), retention: await this.snapshots.status() },
			polls: state?.chatId ? await this.polls.current(state.chatId) : [],
			trial: access?.trial ?? null,
			access,
			cache: await this.cache.report(),
			entries: page.items.map((entry) => `${entry.kind}: ${JSON.stringify(entry.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : "").slice(0, 300)}`),
		};
	}

	/** Renewal-only alarms never open the harness, call a model, or send a Telegram message. */
	async alarm(): Promise<void> {
		if (await this.snapshots.workDue()) {
			const workId = await this.snapshots.scheduleWork(Date.now() + WATCHDOG_MS);
			await this.watchdog(workId);
		}
		await this.snapshots.renewIfDue();
	}

	/** Wakes the object while answers are owed: unfinished runs continue, and unsent answers are sent. */
	private async watchdog(workId: string | undefined): Promise<void> {
		const open = await this.open();
		const state = await open.harness.snapshot(State, context);
		const owed = Object.entries(state?.pending ?? {});
		await open.runtime.recover();
		if (owed.length > 0) return void (await this.snapshots.scheduleWork(Date.now() + WATCHDOG_MS, workId));
		// Nothing is owed any more. Once the computer has had time to go idle and stop, its last stretch is reported.
		const reportAt = await this.machine?.reportAt();
		if (reportAt && reportAt > 0) return void (await this.snapshots.scheduleWork(reportAt, workId));
		await this.reportUsage(open);
		await this.snapshots.scheduleWork(null, workId);
	}

	/** What a message brought, as model input: its text, images inline, speech as text. */
	private async contentOf(open: Open, inbound: Inbound): Promise<InputContent> {
		const notes: string[] = [];
		if (inbound.callback) notes.push(`[Telegram button click] ${JSON.stringify({ message_id: inbound.callback.messageId, user_id: inbound.callback.userId, data: inbound.callback.data })}`);
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
		const model = typeof state?.model === "string" ? { provider: open.provider, modelId: state.model } : state?.model ?? { provider: open.provider, modelId: open.defaultModel };
		return inputContent({ ...inbound, notes }, {
			seesImages: open.models.getModel(model.provider, model.modelId)?.input.includes("image") ?? false,
			read: (file) => this.telegram.download(file.fileId),
			transcribe: async (file) => { const text = await this.transcribe(await this.telegram.download(file.fileId), file.mime ?? "audio/ogg", file.name); await this.count({ transcriptions: 1 }); return text; },
			save: this.machine ? async (file) => {
				const path = `${this.machine!.workspace}/inbox/${inbound.updateId}_${file.name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
				await this.machine!.write(path, await this.telegram.download(file.fileId));
				return path;
			} : undefined,
			permanent: (error) => error instanceof TelegramError && error.permanent,
		});
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

}
