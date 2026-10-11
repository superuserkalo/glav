// Opt-in billed prompt check with synthetic facts; no Telegram calls or real code redemption.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { accessPrompt } from "../src/access.ts";
const configured = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
const provider = openaiProvider();
const model = provider.getModels().find((value) => value.id === "gpt-6-luna");
assert.ok(model);
const settings = { betaMode: true, waitlistEnabled: true, codesEnabled: true, freeMessages: 20, betaCampaign: "launch", subscriptionMonthlyUsd: 25 };
const state = { tier: "free", agent: false, freeUsed: 0, freeRemaining: 20, waitlisted: true, settings,
	campaign: { id: "launch", purpose: "Beta goodie", durationDays: 1, limit: 100, issued: 100, enabled: true, mode: "start", redeemed: 1, remaining: 0, availableCodes: 99 } };
const text = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
const records = [];
async function request(scenario, messages) {
	const reply = await provider.streamSimple(model, { messages }, { apiKey: configured.OPENAI_API_KEY, maxTokens: 250, reasoning: "off", maxRetries: 0 }).result();
	if (!["stop", "toolUse"].includes(reply.stopReason)) throw Error(`Prompt check failed: ${reply.errorMessage ?? reply.stopReason}`);
	const record = { scenario, response: text(reply), totalCostUsd: reply.usage.cost.total };
	records.push(record); console.log(JSON.stringify(record)); return reply;
}
const system = (value, tools, introduction = false) => ({ role: "system", content: accessPrompt(value, "Kaloyan", introduction), ...(tools ? { toolsAdded: tools } : {}), timestamp: 0 });
const user = (content) => ({ role: "user", content, timestamp: 0 });
const results = await Promise.allSettled([
	request("beta-greeting", [system(state, undefined, true), user("Hey")]).then((reply) => {
		assert.match(text(reply), /beta|limited/i); assert.match(text(reply), /waitlist/i);
	}),
	request("payment-question", [system(state), user("I want to pay. Send me the payment link.")]).then((reply) => {
		assert.match(text(reply), /25/); assert.ok(!/https?:\/\//.test(text(reply))); assert.match(text(reply), /not|isn't|isn’t|yet|no checkout/i);
	}),
	request("beta-disabled", [system({ ...state, waitlisted: false, campaign: undefined, settings: { ...settings, betaMode: false } }), user("Hey, how does this work?")]).then((reply) => {
		assert.ok(!/beta|waitlist|limited spots|scarce|invite.only/i.test(text(reply))); assert.match(text(reply), /20/);
	}),
]);
for (const result of results) if (result.status === "rejected") throw result.reason;
const code = `GLAV-${"A".repeat(32)}`;
const tools = [{ name: "activate_trial", description: "Redeem this user's supplied code; campaign determines duration and returns exact expiry.",
	parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } }];
const initial = [system(state, tools), user(`Activate my trial: ${code}`)];
const activation = await request("activation-tool", initial);
const call = activation.content.find((part) => part.type === "toolCall");
assert.equal(call?.name, "activate_trial"); assert.equal(call.arguments.code, code);
const startedAt = Math.floor(Date.now() / 1000) * 1000, endsAt = startedAt + 3 * 86_400_000;
const grant = { status: "active", startedAt, endsAt };
const activated = { ...state, tier: "trial", agent: true, waitlisted: false, trial: { startedAt, endsAt } };
const confirmation = await request("three-day-confirmation", [...initial, activation,
	{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify(grant) }], isError: false, timestamp: startedAt },
	{ role: "system", content: "", sections: { access: accessPrompt(activated, "Kaloyan") }, timestamp: startedAt }]);
assert.ok(!text(confirmation).includes(code));
const expiryDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(endsAt);
assert.ok(text(confirmation).includes(new Date(endsAt).toISOString().slice(0, 10)) || text(confirmation).includes(expiryDate), "Confirmation must include the backend expiry date");
assert.ok(text(confirmation).includes(new Date(endsAt).toISOString().slice(11, 19)), "Confirmation must include the backend expiry time");
const reportAt = process.argv.indexOf("--report");
if (reportAt >= 0) await writeFile(process.argv[reportAt + 1], JSON.stringify({ verifiedAt: new Date().toISOString(), model: model.id, fixture: "Synthetic access facts; no Telegram sends or real codes", records }, null, 2) + "\n");
console.log(JSON.stringify({ passed: records.length, totalCostUsd: records.reduce((sum, row) => sum + row.totalCostUsd, 0) }));
