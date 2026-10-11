import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, ProviderDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { cachePayload, OpenAICache } from "../src/openai-cache.ts";
import { pollContext } from "../src/poll-context.ts";

function storage() {
	const values = new Map();
	return { get: async (key) => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)); } };
}
const model = openaiProvider().getModels().find((m) => m.id === "gpt-6-luna");

test("cache policy preserves prior input and tools, with no volatile instruction content", () => {
	const input = [
		{ role: "developer", content: "stable instructions" },
		{ role: "user", content: [{ type: "input_text", text: "first question" }] },
		...Array.from({ length: 24 }, (_, i) => ({ type: "function_call_output", call_id: `call_${i}`, output: `result ${i}` })),
	];
	const payload = { model: model.id, prompt_cache_key: "persisted-session", input, tools: [{ name: "stable_tool", parameters: { type: "object" } }], reasoning: { effort: "none" }, store: false };
	const first = cachePayload(payload, model, "resp_previous");
	const later = cachePayload({ ...payload, input: [...input, { role: "user", content: "changed poll totals" }] }, model, "resp_next");
	assert.deepEqual(later.input.slice(0, first.input.length), first.input, "appending a turn must preserve the serialized prefix");
	assert.deepEqual(first.tools, payload.tools);
	assert.deepEqual(first.reasoning, payload.reasoning);
	assert.equal(first.prompt_cache_key, "persisted-session");
	assert.deepEqual(first.prompt_cache_options, { mode: "implicit", ttl: "30m", comparison_response_id: "resp_previous" });
	assert.equal(JSON.stringify(first.input).match(/prompt_cache_breakpoint/g).length, 3, "three explicit boundaries plus the implicit write slot");
	assert.equal(payload.input[0].content, "stable instructions", "no mutation of persisted history");
	const old = { ...model, compat: { supportsExplicitPromptCacheMode: false } };
	assert.equal(cachePayload(payload, old), payload, "older models never receive modern options");
});

/** Actual SDK + harness requests, with only HTTP replaced; catches dropped options or events. */
test("real provider requests preserve the durable key and diagnose subsequent turns after a restart", async (t) => {
	const state = storage();
	const session = new MemoryStorage();
	// A DO eviction closes the harness, while its database remains available to the next incarnation.
	const closeStorage = session.close.bind(session);
	session.close = async () => {};
	t.after(closeStorage);
	const requests = [];
	let id = 0;
	const transport = async (_url, options) => {
		requests.push(JSON.parse(options.body));
		const responseId = `resp_${++id}`;
		const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
		const response = { id: responseId, status: "completed", output: [item], usage: { input_tokens: 2000, output_tokens: 1, input_tokens_details: { cached_tokens: id === 1 ? 0 : 1800, cache_write_tokens: id === 1 ? 1800 : 100 } }, service_tier: "default", prompt_cache_diagnostics: id === 1 ? undefined : { type: "cache_miss", reason: "input_changed", comparison_reusable_tokens: 1900, cache_missed_tokens: 100, secret_prompt: "never persist this" } };
		const events = [{ type: "response.created", response: { id: responseId } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
	let cache, harness, conversation;
	async function open() {
		cache = new OpenAICache(state);
		const provider = cache.wrap(openaiProvider());
		const models = createModels({ authContext: { env: (name) => name === "OPENAI_API_KEY" ? "sk-test" : undefined } });
		// Inject the transport at the provider boundary, as the harness deliberately curates stream options.
		models.setProvider({ ...provider, streamSimple: (m, messages, options) => provider.streamSimple(m, messages, { ...options, apiKey: "test", fetch: transport }) });
		const registry = createRegistry();
		registry.install(defineExtension({ name: "cache", hooks: [hook(GenerationTask, { afterResponse: (message) => cache.record(message) })] }));
		harness = await Harness.open(session, { models, registry }, context);
		conversation = await harness.root(context);
		await conversation.configure({ model: { provider: "openai", modelId: model.id }, instructions: "Stable developer instructions" }, context);
		harness.resume();
	}
	await open();
	t.after(() => harness.close(context));
	async function ask(text) {
		const submitted = await conversation.submit({ type: "input", content: text }, context);
		const settled = await submitted.wait(context);
		assert.equal(settled.status, "done", JSON.stringify(settled));
	}
	await ask("first question");
	assert.equal(requests[0].input[0].role, "developer", "stable instructions must precede the first dynamic user input");
	assert.equal(requests[0].prompt_cache_options.comparison_response_id, undefined);
	await ask("a poll has one vote");
	assert.equal(requests[1].prompt_cache_options.comparison_response_id, "resp_1");
	assert.deepEqual(requests[1].input.slice(0, requests[0].input.length), requests[0].input);
	const key = requests[0].prompt_cache_key;
	assert.equal(key, (await harness.snapshot(ProviderDoc, conversation.id, context)).sessionId);
	await harness.close(context);
	await open();
	await ask("after restart");
	assert.equal(requests[2].prompt_cache_key, key);
	assert.equal(requests[2].prompt_cache_options.comparison_response_id, "resp_2");
	const report = await cache.report();
	assert.equal(report.requests, 3);
	assert.equal(report.inputTokens, 6000);
	assert.equal(report.cachedTokens, 3600);
	assert.equal(report.cacheWriteTokens, 2000);
	assert.equal(report.tokenHitRate, 0.6);
	assert.equal(report.recent.at(-1).diagnostic.reason, "input_changed");
	assert.ok(report.inputCostUsd > 0);
	assert.ok(!JSON.stringify(report).includes("never persist this"));
	assert.ok(!JSON.stringify(report).includes("Stable developer instructions"));
});

test("cache telemetry failures and opt-out never prevent model requests", async () => {
	const cache = new OpenAICache({ get: async () => { throw Error("failed"); }, put: async () => { throw Error("failed"); } });
	const payload = { model: model.id, input: [{ role: "user", content: "hi" }], prompt_cache_options: { mode: "explicit" } };
	assert.equal(await cache.options({ cacheRetention: "none" }).onPayload(payload, model), payload);
	assert.equal((await cache.options().onPayload(payload, model)).prompt_cache_options.mode, "implicit");
	await cache.record({ provider: "openai", responseId: "resp_x", usage: {}, model: model.id });
});

test("only changed poll snapshots are appended, and a fresh context receives them again", () => {
	const row = { poll: { id: "poll", total_voter_count: 0 }, observation: "at_send", telegram_update_id: null };
	const first = pollContext([row], []);
	const history = [{ role: "user", content: `hello\n\n${first}` }];
	assert.equal(pollContext([row], history), undefined);
	const updated = { ...row, poll: { ...row.poll, total_voter_count: 1 }, observation: "updated", telegram_update_id: 4 };
	assert.match(pollContext([updated], history), /"total_voter_count":1/);
	assert.equal(pollContext([updated], [...history, { role: "user", content: pollContext([updated], history) }]), undefined);
	assert.match(pollContext([updated], []), /"total_voter_count":1/);
});
