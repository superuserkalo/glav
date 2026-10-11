import { type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type StreamOptions } from "@earendil-works/pi-ai";
import { type Provider } from "@earendil-works/pi-ai/models";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const KEY = "openai-cache-v1";
const HISTORY = 50;

export type CacheDiagnostic = {
	type: string;
	reason?: string;
	comparison_reusable_tokens?: number;
	cache_missed_tokens?: number;
};
export type CacheRecord = {
	responseId: string;
	model: string;
	at: string;
	inputTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	inputCostUsd: number;
	totalCostUsd: number;
	latencyMs?: number;
	serviceTier?: string;
	diagnostic?: CacheDiagnostic;
};
type Totals = { requests: number; inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; inputCostUsd: number; totalCostUsd: number };
type Ledger = { baselines: Record<string, string>; totals: Totals; recent: CacheRecord[] };
type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<unknown> };
type Observed = { key: string; completed: boolean; latencyMs: number; serviceTier?: string; diagnostic?: CacheDiagnostic };

function empty(): Ledger {
	return { baselines: {}, totals: { requests: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, inputCostUsd: 0, totalCostUsd: 0 }, recent: [] };
}

/** Keep the SDK's persisted session key; diagnostics are scoped to that same conversation. */
function baselineKey(payload: ObjectValue): string {
	return typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : "no-key";
}

/** Only metadata is retained. Provider events can contain the entire prompt or answer. */
function diagnosticOf(value: unknown): CacheDiagnostic | undefined {
	if (!object(value) || typeof value.type !== "string") return;
	const diagnostic: CacheDiagnostic = { type: value.type };
	if (typeof value.reason === "string") diagnostic.reason = value.reason;
	for (const field of ["comparison_reusable_tokens", "cache_missed_tokens"] as const) {
		if (typeof value[field] === "number") diagnostic[field] = value[field];
	}
	return diagnostic;
}

/** A text boundary is advisory metadata, never added to the model's instructions. */
function mark(content: unknown): unknown {
	const blocks = typeof content === "string" ? [{ type: "input_text", text: content }] : content;
	if (!Array.isArray(blocks)) return blocks;
	const index = blocks.findLastIndex((part) => object(part) && part.type === "input_text");
	return blocks.map((part, i) => i === index ? { ...part, prompt_cache_breakpoint: { mode: "explicit" } } : part);
}

/** GPT-5.6+ use implicit conversation caching plus at most three explicit write boundaries. */
export function cachePayload(payload: unknown, model: Model<Api>, comparisonResponseId?: string): unknown {
	if (!object(payload) || model.api !== "openai-responses" || !model.baseUrl.startsWith("https://api.openai.com/")) return payload;
	if (!model.compat || !("supportsExplicitPromptCacheMode" in model.compat) || !model.compat.supportsExplicitPromptCacheMode) return payload;
	const options = object(payload.prompt_cache_options) ? payload.prompt_cache_options : {};
	const input = Array.isArray(payload.input) ? payload.input : [];
	const outputs = input.flatMap((item, i) => object(item) && item.type === "function_call_output" ? [i] : []);
	const boundaries = new Set(outputs.slice(-2));
	// Include the first developer/system message even when the harness puts it after the initial user message.
	const initial = input.findIndex((item) => object(item) && (item.role === "developer" || item.role === "system"));
	if (initial >= 0) boundaries.add(initial);
	return {
		...payload,
		prompt_cache_retention: undefined,
		prompt_cache_options: { ...options, mode: "implicit", ttl: "30m", ...(comparisonResponseId ? { comparison_response_id: comparisonResponseId } : {}) },
		input: input.map((item, i) => {
			if (!object(item)) return item;
			if (item.type === "function_call_output") {
				// Normalize EVERY historical output consistently, so moving the latest boundary never changes its shape.
				const output = typeof item.output === "string" ? [{ type: "input_text", text: item.output }] : item.output;
				return { ...item, output: boundaries.has(i) ? mark(output) : output };
			}
			return boundaries.has(i) ? { ...item, content: mark(item.content) } : item;
		}),
	};
}

/** Request policy and bounded, durable accounting. An observability failure must never fail an answer. */
export class OpenAICache {
	private readonly storage: Storage;
	private readonly observed = new Map<string, Observed>();
	private writes: Promise<unknown> = Promise.resolve();
	constructor(storage: Storage) { this.storage = storage; }

	wrap(provider: Provider<"openai-responses">): Provider<"openai-responses"> {
		return {
			...provider,
			stream: (model, context, options) => provider.stream(model, context, this.options(options)),
			streamSimple: (model, context, options) => provider.streamSimple(model, context, this.options(options)),
		};
	}

	options<T extends StreamOptions | SimpleStreamOptions>(options?: T): T {
		const began = Date.now();
		let key = "no-key";
		return {
			...options,
			onPayload: async (original, model) => {
				const payload = await options?.onPayload?.(original, model) ?? original;
				if (!object(payload)) return payload;
				key = baselineKey(payload);
				if (options?.cacheRetention === "none") return payload;
				let baseline: string | undefined;
				try {
					await this.writes;
					baseline = (await this.storage.get<Ledger>(KEY))?.baselines[key];
				} catch { console.warn("OpenAI cache diagnostics baseline unavailable"); }
				return cachePayload(payload, model, baseline);
			},
			onProviderStreamEvent: async (event, model) => {
				if (object(event) && (event.type === "response.completed" || event.type === "response.incomplete") && object(event.response) && typeof event.response.id === "string") {
					this.observed.set(event.response.id, {
						key, completed: event.type === "response.completed", latencyMs: Date.now() - began,
						serviceTier: typeof event.response.service_tier === "string" ? event.response.service_tier : undefined,
						diagnostic: diagnosticOf(event.response.prompt_cache_diagnostics),
					});
					if (this.observed.size > HISTORY) this.observed.delete(this.observed.keys().next().value!);
				}
				await options?.onProviderStreamEvent?.(event, model);
			},
		} as T;
	}

	/** Called by the harness after normalization, using the SDK's model/tier-aware prices exactly once. */
	async record(message: AssistantMessage): Promise<void> {
		if (message.provider !== "openai" || !message.responseId) return;
		const observation = this.observed.get(message.responseId);
		this.observed.delete(message.responseId);
		const work = this.writes.then(async () => {
			const ledger = await this.storage.get<Ledger>(KEY) ?? empty();
			if (ledger.recent.some((row) => row.responseId === message.responseId)) return;
			const u = message.usage;
			const row: CacheRecord = {
				responseId: message.responseId!, model: message.model, at: new Date().toISOString(),
				inputTokens: u.input + u.cacheRead + u.cacheWrite, cachedTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite,
				outputTokens: u.output, inputCostUsd: u.cost.input + u.cost.cacheRead + u.cost.cacheWrite, totalCostUsd: u.cost.total,
				latencyMs: observation?.latencyMs, serviceTier: observation?.serviceTier, diagnostic: observation?.diagnostic,
			};
			ledger.recent.push(row);
			ledger.recent = ledger.recent.slice(-HISTORY);
			ledger.totals.requests++;
			for (const field of ["inputTokens", "cachedTokens", "cacheWriteTokens", "outputTokens", "inputCostUsd", "totalCostUsd"] as const) ledger.totals[field] += row[field];
			if (observation?.completed && message.stopReason !== "error" && message.stopReason !== "aborted") ledger.baselines[observation.key] = row.responseId;
			// Root and temporary compaction conversations cannot grow this map without bound.
			ledger.baselines = Object.fromEntries(Object.entries(ledger.baselines).slice(-HISTORY));
			await this.storage.put(KEY, ledger);
		});
		this.writes = work.catch(() => { console.warn("OpenAI cache accounting unavailable"); });
		await this.writes;
	}

	async report() {
		await this.writes;
		const ledger = await this.storage.get<Ledger>(KEY) ?? empty();
		return { ...ledger.totals, tokenHitRate: ledger.totals.inputTokens ? ledger.totals.cachedTokens / ledger.totals.inputTokens : 0, recent: ledger.recent };
	}
}
