// A billed, opt-in live check. Run from cloud with: npm run check:cache
// Uses the installed OpenAI provider with invented weather data only. Never sends project prompts, schemas, or history.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { OpenAICache } from "../src/openai-cache.ts";

const configured = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8").catch(() => ""));
const apiKey = process.env.OPENAI_API_KEY ?? configured.OPENAI_API_KEY;
if (!apiKey) throw Error("Set OPENAI_API_KEY or configure cloud/.dev.vars.");
const provider = openaiProvider();
const model = provider.getModels().find((candidate) => candidate.id === (process.env.CACHE_CHECK_MODEL ?? "gpt-6-luna"));
if (!model?.compat?.supportsExplicitPromptCacheMode) throw Error("This check needs a model supporting modern prompt caching.");
const values = new Map();
const storage = { get: async (key) => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)); } };
const declarations = [{ name: "lookup_temperature", description: "Look up a fictional station's temperature.", parameters: { type: "object", properties: { station: { type: "string" } }, required: ["station"], additionalProperties: false } }];
// Stable reference material in this TEST fixture ensures the prefix exceeds the caching minimum.
// Production prompts are never padded. Use the same fixture for both arms.
const reference = Array.from({ length: 30 }, (_, i) => `Fictional station ${i + 1}: The morning temperature is 18 degrees Celsius and the afternoon temperature is 22 degrees Celsius. The sky is clear, the wind is light, and no rain is forecast. These are invented test observations. Use the same units for every station and include the station number when comparing readings.`).join("\n");
const instructions = `You are a fictional weather assistant in a synthetic caching test.\n\n${reference}\n\nFor every verification request, reply with exactly OK. Do not call any tool.`;
const system = { role: "system", content: instructions, toolsAdded: declarations, timestamp: 0 };
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const records = [];
for (const arm of ["sdk-default", "hardened"]) {
	const sessionId = `glav-cache-check:${randomUUID()}`;
	let cache = new OpenAICache(storage);
	let previous;
	async function request(scenario, messages, toolResult = false) {
		let rawDiagnostic;
		const started = Date.now();
		const options = { apiKey, sessionId, maxTokens: 128, reasoning: "off", maxRetries: 0,
			onPayload: (payload) => {
				if (arm === "sdk-default" && previous) payload.prompt_cache_options = { comparison_response_id: previous };
				if (toolResult) payload.input.push(
					{ type: "function_call", call_id: "call_cache_check", name: "lookup_temperature", arguments: '{"station":"2"}' },
					{ type: "function_call_output", call_id: "call_cache_check", output: "The fictional station's temperature is 22 degrees Celsius." },
					{ role: "user", content: "The lookup is finished. Reply with exactly OK." },
				);
			},
			onProviderStreamEvent: (event) => { if (event.type === "response.completed") rawDiagnostic = event.response.prompt_cache_diagnostics; },
		};
		const message = await provider.streamSimple(model, { messages }, arm === "hardened" ? cache.options(options) : options).result();
		if (message.stopReason !== "stop") throw Error(`OpenAI verification did not complete: ${message.errorMessage ?? message.stopReason}`);
		if (arm === "hardened") await cache.record(message);
		previous = message.responseId;
		const u = message.usage;
		const record = { arm, scenario, model: model.id, inputTokens: u.input + u.cacheRead + u.cacheWrite, cachedTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, outputTokens: u.output, inputCostUsd: u.cost.input + u.cost.cacheRead + u.cost.cacheWrite, totalCostUsd: u.cost.total, latencyMs: Date.now() - started, diagnostic: rawDiagnostic };
		records.push(record);
		console.log(JSON.stringify(record));
		return message;
	}
	await request("cold", [system, user("First dynamic input: station one.")]);
	const reply = await request("changed-user-suffix", [system, user("Different dynamic input: station two.")]);
	// Recreate the controller as after a DO eviction, while retaining persisted metadata and session identity.
	cache = new OpenAICache(storage);
	const resumed = [system, user("Different dynamic input: station two."), reply, user("Follow-up: compare the weather stations. Reply OK.")];
	await request("append-after-restart", resumed);
	await request("tool-result-boundary", resumed, true);
	await request("intentional-prefix-change", [{ ...system, content: `Changed instruction prefix.\n${instructions}` }, user("New context. Reply OK.")]);
}
const warm = records.find((row) => row.arm === "hardened" && row.scenario === "changed-user-suffix");
const resumed = records.find((row) => row.arm === "hardened" && row.scenario === "append-after-restart");
assert.ok(warm.cachedTokens >= 1024, "Expected the explicitly preserved stable prefix to be cached.");
assert.ok(resumed.cachedTokens >= warm.cachedTokens, "An append after restart should preserve the reusable prefix.");
const control = records.find((row) => row.arm === "sdk-default" && row.scenario === "changed-user-suffix");
const summary = { changedSuffixInputCostReduction: 1 - warm.inputCostUsd / control.inputCostUsd, warmTokenHitRate: warm.cachedTokens / warm.inputTokens, totalCheckCostUsd: records.reduce((sum, row) => sum + row.totalCostUsd, 0) };
console.log(JSON.stringify({ summary }));
const reportAt = process.argv.indexOf("--report");
if (reportAt >= 0) await writeFile(process.argv[reportAt + 1], JSON.stringify({ verifiedAt: new Date().toISOString(), fixture: "invented weather content only", records, summary }, null, 2) + "\n");
