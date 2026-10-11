import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, type AgentChange, type Conversation, type Harness, LiveDoc, type LiveState, type ModelRef, type SettledSubmissionRecord, type Submission, type SubmissionId, UsageDoc } from "@earendil-works/pi-durable";
import type { InputContent } from "./content.ts";

export type { ModelRef } from "@earendil-works/pi-durable";
export const COMMANDS = [
	{ command: "new", description: "Start a fresh conversation" },
	{ command: "stop", description: "Stop what I am doing" },
	{ command: "model", description: "Show or change the model" },
	{ command: "thinking", description: "Show or change how hard I think" },
	{ command: "compact", description: "Summarize older messages to free up context" },
	{ command: "usage", description: "Tokens and cost of this conversation" },
	{ command: "help", description: "List the commands" },
];
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const context = BACKGROUND_CONTEXT;
const REMEMBERED = 500;

/** Delivery and preferences persisted in the chat's durable document. */
export type ConversationState = {
	pending: Record<string, number>;
	delivered: string[];
	answers?: number[];
	model?: ModelRef;
	thinking?: string;
};
export type RuntimeOptions = {
	harness: Harness;
	conversation: Conversation;
	models: Models;
	defaultModel: ModelRef;
	state: {
		read(): Promise<Readonly<ConversationState> | undefined>;
		/** Must commit the mutation atomically in the host's storage. */
		update(change: (state: ConversationState) => void): Promise<void>;
	};
	configure(state: Readonly<ConversationState> | undefined): AgentChange | Promise<AgentChange>;
	transport: { send(text: string, signal?: AbortSignal): Promise<void>; draft(id: number, text: string): Promise<void> };
	/** Retains asynchronous delivery work with the Durable Object's waitUntil. */
	keepAlive?: (work: Promise<void>) => void;
	onPending?: (fresh: boolean) => Promise<void>;
	onDelivered?: () => Promise<void>;
	onIdle?: () => Promise<void>;
	replyNeeded?: (pending: Record<string, number>, settled: SettledSubmissionRecord) => Promise<boolean>;
	draftNeeded?: (inputs: readonly number[]) => Promise<boolean>;
	draftIntervalMs?: number;
};

export function textOf(message: { content: readonly { type: string; text?: string }[] } | undefined): string {
	return (message?.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}
function remember<T>(list: T[], item: T): void {
	if (!list.includes(item)) list.push(item);
	if (list.length > REMEMBERED) list.splice(0, list.length - REMEMBERED);
}

/** The conversation controller for managed, self-hosted, and local Worker deployments. */
export class ConversationRuntime {
	private readonly options: RuntimeOptions;
	private readonly waits = withCancel(context);
	private readonly deliveries = new Map<string, Promise<void>>();
	private admissions: Promise<unknown> = Promise.resolve();
	private sends: Promise<unknown> = Promise.resolve();
	private closed = false;
	private watch?: { stop(): Promise<unknown> };
	private timer?: ReturnType<typeof setInterval>;
	private live?: Readonly<LiveState> | null;
	private wanted?: { draftId: number; text: string };
	private shown?: { draftId: number; text: string; at: number };
	private pushing = false;
	private readonly calls = new Map<string, string>();
	private describing = false;

	constructor(options: RuntimeOptions) { this.options = options; }

	async start(): Promise<void> {
		await this.configure();
		const { harness, conversation } = this.options;
		const watch = await harness.watchDoc(LiveDoc, conversation.id, context);
		if (!watch) return;
		this.watch = watch;
		this.present(watch.value);
		watch.start(async (live) => this.present(live));
	}

	async configure(): Promise<void> {
		await this.options.conversation.configure(await this.options.configure(await this.options.state.read()), context);
	}

	/** Admission is serialized; waiting for the answer is not, so new input can steer running work. */
	admit(requestId: string, content: () => Promise<InputContent>): Promise<void> {
		const work = this.admissions.then(async () => {
			if (this.closed) throw new Error("runtime closed");
			const state = await this.options.state.read();
			if (state?.delivered.includes(requestId)) return;
			let submission: Submission | undefined;
			if (state?.pending[requestId] !== undefined) submission = await this.options.harness.submission(state.pending[requestId] as SubmissionId, context);
			if (!submission) submission = await this.options.conversation.submit({ type: "input", requestId, content: await content(), whenBusy: "steer" }, context);
			let fresh = false;
			const id = submission.id;
			await this.options.state.update((doc) => {
				fresh = !(requestId in doc.pending);
				doc.pending[requestId] = id;
			});
			await this.options.onPending?.(fresh);
			this.deliver(requestId, submission);
		});
		this.admissions = work.catch(() => undefined);
		return work;
	}

	async recover(): Promise<void> {
		for (const [requestId, id] of Object.entries((await this.options.state.read())?.pending ?? {})) {
			const submission = await this.options.harness.submission(id as SubmissionId, context);
			if (submission) this.deliver(requestId, submission);
		}
	}

	/** Tools, drafts and final replies share this queue, so a draft cannot overtake a tool's send. */
	inOrder<T>(work: () => Promise<T>): Promise<T> {
		const next = this.sends.then(work, work);
		this.sends = next.catch(() => undefined);
		return next;
	}

	say(text: string): void {
		this.retain(this.inOrder(() => this.options.transport.send(text, this.waits.context.abortSignal)).catch((error) => this.log(error)));
	}

	private retain(work: Promise<void>): void { this.options.keepAlive?.(work); }
	private log(error: unknown): void { if (!this.closed) console.error(`conversation runtime: ${error instanceof Error ? error.message : String(error)}`); }

	private deliver(requestId: string, submission: Submission): void {
		if (this.closed || this.deliveries.has(requestId)) return;
		const work = (async () => {
			try {
				const settled = await submission.wait(this.waits.context);
				await this.inOrder(async () => {
					const state = await this.options.state.read();
					if (state?.delivered.includes(requestId)) return;
					const answer = settled.status === "done" && settled.type === "input" ? settled.answer : undefined;
					let text: string | undefined;
					if (answer === undefined) {
						const reason = settled.status === "unanswered" ? settled.reason : "no answer";
						if (reason !== "aborted") text = `Sorry, I couldn't answer that (${reason}).`;
					} else if (!state?.answers?.includes(answer) && await (this.options.replyNeeded?.(state?.pending ?? {}, settled) ?? true)) {
						const entry = await this.options.harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
						const message = entry?.model?.[0] as AssistantMessage | undefined;
						text = textOf(message).trim() || message?.errorMessage || "(empty reply)";
					}
					if (text !== undefined) await this.options.transport.send(text, this.waits.context.abortSignal);
					await this.options.state.update((doc) => {
						delete doc.pending[requestId];
						remember(doc.delivered, requestId);
						if (answer !== undefined) remember(doc.answers ??= [], answer);
					});
				});
				await this.options.onDelivered?.();
			} catch (error) {
				// Pending state remains durable; the host retries at startup or on its watchdog alarm.
				this.log(error);
			} finally { this.deliveries.delete(requestId); }
		})();
		this.deliveries.set(requestId, work);
		this.retain(work);
	}

	private present(live: Readonly<LiveState> | null): void {
		if (this.closed) return;
		this.live = live;
		if (!live?.run) {
			clearInterval(this.timer);
			this.timer = this.wanted = this.shown = undefined;
			this.calls.clear();
			if (this.options.onIdle) this.retain(this.options.onIdle().catch((error) => this.log(error)));
			return;
		}
		if (!this.describing && live.tools?.some((slot) => !this.calls.has(slot.callId))) void this.describeCalls();
		const tools = (live.tools ?? []).filter((slot) => slot.status !== "done").map((slot) => `⚙️ ${this.calls.get(slot.callId) ?? slot.name}`);
		this.wanted = { draftId: live.run.inputs[0] ?? live.run.taskId, text: [textOf(live.generation?.message as AssistantMessage | undefined).trim(), ...tools].filter(Boolean).join("\n\n") };
		this.timer ??= setInterval(() => void this.pushDraft(), this.options.draftIntervalMs ?? 1000);
		void this.pushDraft();
	}

	private async describeCalls(): Promise<void> {
		this.describing = true;
		try {
			const { messages } = await this.options.conversation.context(context);
			for (const part of messages.findLast((message) => message.role === "assistant")?.content ?? []) {
				if (part.type !== "toolCall") continue;
				const detail = part.name === "bash" ? part.arguments?.command : part.arguments?.path;
				this.calls.set(part.id, typeof detail === "string" ? `${part.name}: \`${detail.slice(0, 200)}\`` : part.name);
			}
			for (const slot of this.live?.tools ?? []) if (!this.calls.has(slot.callId)) this.calls.set(slot.callId, slot.name);
			if (this.live?.run) this.present(this.live);
		} catch (error) { this.log(error); }
		finally { this.describing = false; }
	}

	private async pushDraft(): Promise<void> {
		const { wanted, shown } = this;
		if (!wanted || this.pushing || this.closed) return;
		const interval = this.options.draftIntervalMs ?? 1000;
		const now = Date.now();
		const changed = shown?.draftId !== wanted.draftId || shown.text !== wanted.text;
		if (shown && now - shown.at < (changed ? interval : 4000)) return;
		this.pushing = true;
		this.shown = { ...wanted, at: now };
		try {
			await this.inOrder(async () => {
				const live = await this.options.harness.snapshot(LiveDoc, this.options.conversation.id, context);
				if (wanted !== this.wanted || !live?.run || this.closed) return;
				if (!await (this.options.draftNeeded?.(live.run.inputs) ?? true)) {
					clearInterval(this.timer);
					this.timer = this.wanted = this.shown = undefined;
					return;
				}
				await this.options.transport.draft(wanted.draftId, wanted.text);
			});
		} catch { /* Drafts are best effort; final replies remain pending until delivered. */ }
		finally { this.pushing = false; }
	}

	async stop(): Promise<void> {
		const { harness, conversation } = this.options;
		const busy = (await harness.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
		await conversation.abort(context);
		this.say(busy ? "Stopped." : "Nothing is running.");
	}

	/** The chat gates which commands an account may use before calling this method. */
	async command(text: string, help?: string): Promise<boolean> {
		const match = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return false;
		const name = match[1]!;
		const arg = (match[2] ?? "").trim();
		const { harness, conversation, models } = this.options;
		switch (name) {
			case "start": case "help": this.say(help ?? ["Send me a message, photo, voice note or file.", "", ...COMMANDS.map((c) => `/${c.command} - ${c.description}`)].join("\n")); return true;
			case "stop": await this.stop(); return true;
			case "new": await conversation.abort(context); await conversation.reset(undefined, context); this.say("Started a fresh conversation."); return true;
			case "compact": await conversation.compact(arg || undefined, context); this.say("Summarizing the older part of this conversation."); return true;
			case "usage": {
				const usage = await harness.snapshot(UsageDoc, conversation.id, context);
				this.say(Object.entries(usage?.models ?? {}).map(([model, u]) => `${model}: ${u.input + u.cacheRead + u.cacheWrite} tokens in, ${u.output} out, $${u.cost.total.toFixed(4)}`).join("\n") || "Nothing used yet.");
				return true;
			}
			case "model": {
				const current = (await this.options.state.read())?.model ?? this.options.defaultModel;
				if (!arg) { this.say(`Model: ${current.provider}/${current.modelId}\nChange it with /model <id> or /model <provider>/<id>.`); return true; }
				const slash = arg.indexOf("/");
				const wanted = slash < 0 ? { provider: current.provider, modelId: arg } : { provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) };
				if (!models.getModel(wanted.provider, wanted.modelId)) {
					const known = models.getModels(wanted.provider).map((model) => model.id);
					this.say(`I don't know ${wanted.provider}/${wanted.modelId}.${known.length ? ` Models of ${wanted.provider}: ${known.join(", ")}` : ""}`);
				} else {
					await this.options.state.update((doc) => { doc.model = wanted; });
					await this.configure(); this.say(`Model: ${wanted.provider}/${wanted.modelId}`);
				}
				return true;
			}
			case "thinking": {
				if (!arg) this.say(`Thinking: ${(await conversation.agent(context)).thinkingLevel}\nLevels: ${THINKING_LEVELS.join(", ")}`);
				else if (!THINKING_LEVELS.includes(arg as ModelThinkingLevel)) this.say(`Levels: ${THINKING_LEVELS.join(", ")}`);
				else { await this.options.state.update((doc) => { doc.thinking = arg; }); await this.configure(); this.say(`Thinking: ${arg}`); }
				return true;
			}
			default: return false;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.waits.cancel();
		clearInterval(this.timer);
		await this.admissions;
		await Promise.allSettled([...this.deliveries.values(), this.sends, this.watch?.stop()]);
	}
}
