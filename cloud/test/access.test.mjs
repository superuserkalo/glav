import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Access, accessPrompt } from "../src/access.ts";
import { Trials, TRIAL_MS, TrialLimitError } from "../src/trials.ts";
import { trialTools } from "../src/trial-tools.ts";
import { database } from "./sqlite.mjs";

test("20 free messages are counted once, survive reopening, and racing requests cannot buy a 21st", async (t) => {
	const { db } = database(t);
	const access = new Access(db);
	assert.equal((await access.state(11)).tier, "free");
	for (let update = 1; update <= 19; update++) assert.equal(await access.freeTurn(11, update, true), true);
	assert.equal(await new Access(db).freeTurn(11, 1, true), true);
	assert.equal((await access.state(11)).freeUsed, 19);
	const candidates = await Promise.all([access.freeTurn(11, 20, true), new Access(db).freeTurn(11, 21, true)]);
	assert.equal(candidates.filter(Boolean).length, 1);
	assert.equal((await new Access(db).state(11)).freeUsed, 20);
	assert.equal((await access.state(11)).tier, "closed");
	assert.equal(await access.freeTurn(11, 22, true), false);
	assert.equal(await access.freeTurn(12, 20), false, "another account cannot reuse a receipt");
	assert.equal((await access.state(12)).freeRemaining, 20);
	assert.equal((await access.state(11, -200)).agent, false);
});

test("the beta flag removes marketing, while free limits, real waitlist data, and existing trial grants remain independent", async (t) => {
	const { db } = database(t);
	const access = new Access(db);
	await access.joinWaitlist(11); await access.joinWaitlist(11);
	assert.equal((await access.waitlist()).waiting, 1);
	const beta = accessPrompt(await access.state(11), "Kaloyan", true);
	assert.match(beta, /This is the first conversation turn/);
	assert.ok(!accessPrompt(await access.state(11)).includes("This is the first conversation turn"));
	assert.match(beta, /"waitlistJoined":true/);
	assert.match(beta, /"totalCodes":100/);
	assert.match(beta, /"durationDays":1/);
	assert.match(beta, /"plannedSubscriptionMonthlyUsd":25/);
	await access.settings({ betaMode: false });
	const normal = accessPrompt(await new Access(db).state(11));
	assert.ok(!normal.includes('"beta":true'));
	assert.ok(!normal.includes('"waitlistJoined"'));
	assert.ok(!normal.includes('"offer"'));
	assert.equal((await access.state(11)).freeRemaining, 20);
	await access.joinWaitlist(12);
	assert.equal((await access.waitlist()).waiting, 1, "turning beta off stops automatic enrollment");
	const { codes: [code] } = await access.trials.issue();
	assert.equal((await access.redeem(11, code)).status, "active");
	assert.equal((await access.waitlist()).waiting, 0);
	await access.settings({ codesEnabled: false });
	assert.equal((await access.state(11)).agent, true, "disabling new codes does not revoke paid or trial access");
	await assert.rejects(access.settings({ freeMessages: -1 }), /Invalid setting/);
	await assert.rejects(access.settings({ betaMode: "false" }), /Invalid setting/);
	await assert.rejects(access.settings({ unknownFlag: true }), /Invalid setting/);
	await assert.rejects(access.settings({ constructor: 25 }), /Invalid setting/);
});

test("a separate three-day campaign works after a one-day trial, freezes issued terms, and has its own limit", async (t) => {
	const { db } = database(t);
	let now = 1000;
	const trials = new Trials(db, () => now);
	const one = (await trials.issue()).codes[0];
	assert.equal((await trials.redeem(11, one)).endsAt, now + TRIAL_MS);
	now += TRIAL_MS;
	await trials.configure("standard", { purpose: "Standard trial", durationDays: 3, limit: 2 });
	const [three, other] = (await trials.issue(2, 7, "standard")).codes;
	await trials.configure("standard", { durationDays: 5 });
	assert.equal((await trials.redeem(11, three)).endsAt, now + 3 * TRIAL_MS, "issued terms stay at three days");
	assert.equal(await trials.canRedeem(11, other), false, "one reward per account per campaign");
	assert.equal(await trials.canRedeem(12, other), true);
	await assert.rejects(trials.issue(1, 7, "standard"), (error) => error instanceof TrialLimitError && error.limit === 2);
	assert.equal((await trials.campaign("launch")).issued, 1);
	await assert.rejects(trials.configure("standard", { limit: 1 }), /below issued/);
	await assert.rejects(trials.configure("bad", { durationDays: "3" }), /Invalid campaign/);
});

test("extension rewards add arbitrary durations once and replay cannot shorten or lengthen later access", async (t) => {
	const { db } = database(t);
	let now = 1000;
	const trials = new Trials(db, () => now);
	const launch = (await trials.issue()).codes[0];
	await trials.redeem(11, launch);
	await trials.configure("reward", { durationDays: 2.5, mode: "extend", limit: 1 });
	const reward = (await trials.issue(1, 7, "reward")).codes[0];
	now += 5000;
	const grant = await trials.redeem(11, reward);
	assert.equal(grant.endsAt, 1000 + 3.5 * TRIAL_MS);
	assert.deepEqual(await trials.redeem(11, reward), grant);
	await trials.redeem(11, launch);
	assert.equal((await trials.access(11)).endsAt, grant.endsAt);
	await trials.configure("unlimited", { durationDays: 400, limit: null });
	assert.equal((await trials.issue(100, 7, "unlimited")).remaining, null);
});

test("campaign retirement stops unused-code activation but keeps grants and does not consume disabled codes", async (t) => {
	const { db, sqlite } = database(t);
	const access = new Access(db);
	const [one, two] = (await access.trials.issue(2)).codes;
	await access.redeem(11, one);
	await access.trials.configure("launch", { enabled: false });
	assert.equal(await access.canRedeem(12, two), false);
	assert.equal((await access.redeem(12, two)).status, "invalid");
	assert.equal((await access.state(11)).agent, true);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_codes").get().count, 1);
	await access.trials.configure("launch", { enabled: true });
	await access.settings({ codesEnabled: false });
	assert.equal(await access.canRedeem(12, two), false);
	assert.equal((await access.redeem(12, two)).status, "invalid");
	await access.settings({ codesEnabled: true });
	assert.equal(await access.canRedeem(12, two), true);
});

test("legacy migration retains issued capacity and exact grants, then runs once across other campaigns", async (t) => {
	const { db, sqlite } = database(t);
	sqlite.exec(`CREATE TABLE trial_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE trial_access (user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);
		CREATE TABLE trial_campaign (id INTEGER PRIMARY KEY, issued INTEGER NOT NULL);
		INSERT INTO trial_campaign VALUES (1, 100);
		INSERT INTO trial_codes VALUES ('legacy', 100, 900000);
		INSERT INTO trial_access VALUES (11, 'used', 123, 999999)`);
	const trials = new Trials(db, () => 1000);
	assert.equal((await trials.campaign()).issued, 100);
	assert.deepEqual(await trials.access(11), { startedAt: 123, endsAt: 999999 });
	await trials.configure("next", { durationDays: 3, limit: 1 });
	await trials.issue(1, 7, "next");
	assert.equal((await new Trials(db).campaign("next")).issued, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM access_code_terms WHERE campaign_id = 'launch'").get().count, 1);
});

test("subscriptions alone unlock agent tools and expiry falls back to unused free messages", async (t) => {
	const { db } = database(t);
	let now = 1000;
	const access = new Access(db, { ALLOWED_USERS: "7,-200" }, () => now);
	await access.joinWaitlist(11);
	await access.subscription(11, now + TRIAL_MS, "operator-confirmed-payment");
	assert.equal((await access.state(11)).tier, "subscription");
	assert.equal((await access.waitlist()).waiting, 0);
	assert.equal((await access.state(11, -200)).agent, false);
	assert.equal((await access.state(7, -200)).tier, "permanent");
	now += TRIAL_MS;
	assert.equal((await access.state(11)).tier, "free");
	assert.equal((await access.state(11)).agent, false);
});

test("an admitted free model turn cannot use computer or Telegram tools, even if the model requests them", async (t) => {
	const { db } = database(t);
	const access = new Access(db);
	await access.freeTurn(11, 1, true);
	let used = 0;
	const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	const extension = trialTools(access, async () => ({ chatId: 11, updateId: 1 }));
	registry.install(extension.extension);
	registry.install(defineExtension({ name: "computer", tools: [defineTool({ name: "bash", description: "Run commands", parameters: Type.Object({}),
		execute: async () => { used++; return { content: [{ type: "text", text: "ran" }] }; } })] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	await conversation.configure({ model: { provider: "faux", modelId: faux.getModel().id } }, context);
	harness.resume();
	let result, prompt;
	faux.appendResponses([
		(transcript) => { prompt = JSON.stringify(transcript.messages.filter((message) => message.role === "system")); return fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }); },
		(transcript) => { result = transcript.messages.findLast((message) => message.role === "toolResult"); return fauxAssistantMessage("We can plan it here."); },
	]);
	assert.equal((await (await conversation.submit({ type: "input", content: "Run a command" }, context)).wait(context)).status, "done");
	assert.equal(used, 0);
	assert.equal(result.isError, true);
	assert.ok(prompt.includes('\\"agentAvailable\\":false'));
	assert.ok(prompt.includes('\\"freeMessagesRemaining\\":19'));
});
