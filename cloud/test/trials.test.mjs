import assert from "node:assert/strict";
import { database } from "./sqlite.mjs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { TRIAL_CODE_LIMIT, TRIAL_MS, trialCodeIn, TrialLimitError, Trials } from "../src/trials.ts";
import { trialTools } from "../src/trial-tools.ts";
import { Access } from "../src/access.ts";


test("one-use code grants exactly 24 hours, is removed, and retries never extend it", async (t) => {
	const { db, sqlite } = database(t);
	let now = 1000;
	const trials = new Trials(db, () => now);
	const { codes: [code] } = await trials.issue();
	assert.equal(sqlite.prepare("SELECT code_hash FROM trial_codes").get().code_hash.length, 64);
	assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM trial_codes").get()).includes(code));
	assert.equal(await trials.canRedeem(11, code), true);
	assert.deepEqual(await trials.redeem(11, code), { status: "active", startedAt: now, endsAt: now + TRIAL_MS });
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_codes").get().count, 0);
	now += 5000;
	assert.deepEqual(await trials.redeem(11, code), { status: "active", startedAt: 1000, endsAt: 1000 + TRIAL_MS });
	assert.deepEqual(await trials.redeem(12, code), { status: "invalid" });
	const { codes: [another] } = await trials.issue();
	assert.deepEqual(await trials.redeem(11, another), { status: "already_used" });
	assert.equal(await trials.canRedeem(12, another), true, "an ineligible user cannot burn a new code");
	now = 1000 + TRIAL_MS;
	assert.equal(await trials.access(11), undefined, "expiry is exclusive and checked on every access");
	assert.deepEqual(await trials.redeem(11, code), { status: "already_used" });
	assert.deepEqual(await trials.redeem(11, another), { status: "already_used" });
});

test("only 100 launch codes can ever be issued, including redeemed and expired codes", async (t) => {
	const { db, sqlite } = database(t);
	let now = 1000;
	const trials = new Trials(db, () => now);
	const first = await trials.issue();
	assert.equal(first.remaining, 99);
	assert.equal((await trials.redeem(11, first.codes[0])).status, "active");
	const rest = await trials.issue(99);
	assert.equal(rest.remaining, 0);
	assert.equal(sqlite.prepare("SELECT issued FROM access_campaigns WHERE id = 'launch'").get().issued, 100);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_codes").get().count, 99);
	await assert.rejects(trials.issue(), (error) => error instanceof TrialLimitError && error.remaining === 0);
	now += 8 * TRIAL_MS;
	await assert.rejects(new Trials(db, () => now).issue(), (error) => error instanceof TrialLimitError && error.remaining === 0);
	assert.equal(sqlite.prepare("SELECT issued FROM access_campaigns WHERE id = 'launch'").get().issued, TRIAL_CODE_LIMIT);
});

test("concurrent issuers cannot exceed the last available launch slot", async (t) => {
	const { db, sqlite } = database(t);
	await new Trials(db).issue(99);
	const results = await Promise.allSettled([new Trials(db).issue(), new Trials(db).issue()]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected.reason instanceof TrialLimitError);
	assert.equal(rejected.reason.remaining, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_codes").get().count, 100);
	assert.equal(sqlite.prepare("SELECT issued FROM access_campaigns WHERE id = 'launch'").get().issued, 100);
});

test("existing redeemed and unused codes seed the lifetime launch limit", async (t) => {
	const { db, sqlite } = database(t);
	sqlite.exec(`CREATE TABLE trial_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE trial_access (user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);
		INSERT INTO trial_codes VALUES ('legacy-unused', 0, 1);
		INSERT INTO trial_access VALUES (11, 'legacy-used', 0, 1)`);
	const trials = new Trials(db);
	await assert.rejects(trials.issue(99), (error) => error instanceof TrialLimitError && error.remaining === 98);
	assert.equal((await trials.issue(98)).remaining, 0);
});

test("failed issuance does not reserve slots or leave a partial batch", async (t) => {
	const { db, sqlite, failInsertion } = database(t);
	const trials = new Trials(db);
	await trials.issue();
	failInsertion(true);
	await assert.rejects(trials.issue(99), /injected code insert failure/);
	assert.equal(sqlite.prepare("SELECT issued FROM access_campaigns WHERE id = 'launch'").get().issued, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_codes").get().count, 1);
	failInsertion(false);
	assert.equal((await trials.issue(99)).remaining, 0);
});

test("the backend admits at most 100 distinct trial accounts", async (t) => {
	const { db, sqlite } = database(t);
	const trials = new Trials(db, () => 1000);
	const { codes } = await trials.issue(100);
	for (let i = 0; i < codes.length; i++) assert.equal((await trials.redeem(i + 1, codes[i])).status, "active");
	const extra = `GLAV-${"F".repeat(32)}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(extra));
	const extraHash = Buffer.from(digest).toString("hex");
	sqlite.prepare("INSERT INTO trial_codes VALUES (?, ?, ?)").run(extraHash, 1000, 1000 + TRIAL_MS);
	sqlite.prepare("INSERT INTO access_code_terms VALUES (?, ?, ?, ?)").run(extraHash, "launch", TRIAL_MS, "start");
	assert.equal(await trials.canRedeem(101, extra), false);
	assert.deepEqual(await trials.redeem(101, extra), { status: "invalid" });
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_access").get().count, 100);
	assert.equal((await trials.redeem(1, codes[0])).status, "active", "retries of admitted accounts still succeed without a new spot");
});

test("a failed consume rolls back the grant and leaves the code redeemable", async (t) => {
	const { db, sqlite, failDeletion } = database(t);
	const trials = new Trials(db);
	const { codes: [code] } = await trials.issue();
	failDeletion(true);
	await assert.rejects(trials.redeem(11, code), /injected deletion failure/);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trial_access").get().count, 0);
	failDeletion(false);
	assert.equal(await trials.canRedeem(11, code), true);
	assert.equal((await trials.redeem(11, code)).status, "active");
});

test("expired codes, groups, ambiguous input, and malformed codes cannot activate", async (t) => {
	const { db } = database(t);
	let now = 1000;
	const trials = new Trials(db, () => now);
	const { codes: [one, two], expiresAt } = await trials.issue(2, 1);
	assert.equal(trialCodeIn(`My trial code is ${one.toLowerCase()}. Please activate it.`), one);
	assert.equal(trialCodeIn(`${one} ${one}`), one);
	assert.equal(trialCodeIn(`${one} ${two}`), undefined);
	assert.equal(trialCodeIn(`x${one}`), undefined);
	assert.deepEqual(await trials.redeem(-200, one), { status: "invalid" });
	assert.deepEqual(await trials.redeem(11, "guess"), { status: "invalid" });
	now = expiresAt;
	assert.equal(await trials.canRedeem(11, one), false);
	assert.deepEqual(await trials.redeem(11, one), { status: "invalid" });
	await assert.rejects(trials.issue(101), /count/);
});

test("the model activates through a bound tool and cannot use normal tools before activation or after expiry", async (t) => {
	const { db } = database(t);
	let now = 1000;
	const access = new Access(db, {}, () => now);
	const trials = access.trials;
	const { codes: [code, other] } = await trials.issue(2);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	let used = 0;
	const normal = defineTool({ name: "normal", description: "An ordinary tool", parameters: Type.Object({}),
		execute: async () => { used++; return { content: [{ type: "text", text: "ran" }] }; } });
	const trial = trialTools(access, async () => ({ chatId: 11, code }));
	registry.install(trial.extension);
	registry.install(defineExtension({ name: "ordinary", tools: [normal] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	await conversation.configure({ model: { provider: "faux", modelId: faux.getModel().id }, instructions: "Activate the supplied trial code." }, context);
	harness.resume();
	async function invoke(name, args) {
		let result;
		faux.appendResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			(transcript) => { result = transcript.messages.findLast((message) => message.role === "toolResult"); return fauxAssistantMessage("done"); },
		]);
		assert.equal((await (await conversation.submit({ type: "input", content: `Activate ${code}` }, context)).wait(context)).status, "done");
		return result;
	}
	assert.equal((await invoke("normal", {})).isError, true);
	assert.equal(used, 0);
	assert.equal((await invoke("activate_trial", { code: other })).isError, true, "a code absent from this user's message cannot be consumed");
	assert.equal(await trials.canRedeem(12, other), true);
	const activated = await invoke("activate_trial", { code });
	assert.equal(activated.isError, false);
	assert.equal(JSON.parse(activated.content[0].text).endsAt, now + TRIAL_MS);
	assert.equal((await invoke("normal", {})).isError, false);
	assert.equal(used, 1);
	now += TRIAL_MS;
	const guard = trial.extension.hooks.find((entry) => entry.task === "pi.tool");
	assert.match((await guard.handlers.beforeTool({ name: "normal" })).block, /expired/);
	const generation = trial.extension.hooks.find((entry) => entry.task === "pi.generation");
	await assert.rejects(generation.handlers.beforeRequest(), /expired/);
});
