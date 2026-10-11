// End to end: the real Worker under wrangler's local runtime, a stand-in model, and a fake Telegram.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const PORT = Number(process.env.GLAV_TEST_PORT) || 8797;
const SECRET = "hook-secret";
const worker = `http://127.0.0.1:${PORT}`;

/** Every Bot API call the Worker made, and scripted failures by method. */
const calls = [];
const failures = {};
const telegram = createServer(async (request, response) => {
	if (request.url.includes("/file/bot")) return response.end("file bytes");
	let body = "";
	for await (const chunk of request) body += chunk;
	const method = request.url.split("/").pop();
	const params = Object.fromEntries(new URLSearchParams(body));
	const failure = failures[method]?.shift();
	calls.push({ method, failed: failure !== undefined, ...params });
	if (failure) return response.end(JSON.stringify(failure));
	response.end(JSON.stringify({ ok: true, result: method === "getFile" ? { file_path: "files/1" } : true }));
});

let directory;
let wrangler;

async function start() {
	wrangler = spawn(
		"npx",
		["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", directory, "--show-interactive-dev-session=false",
			...(process.env.GLAV_TEST_NO_COMPUTER ? ["--enable-containers=false"] : []),
			"--var", `TELEGRAM_API:http://127.0.0.1:${telegram.address().port}`, "--var", "TELEGRAM_KEY:TOKEN", "--var", `WEBHOOK_SECRET:${SECRET}`,
			"--var", "AGENT_SECRET:setup-secret", "--var", "FREE_MESSAGES:0", "--var", "BETA_MODE:false", "--var", "ALLOWED_USERS:7,-200", "--var", "MODEL_PROVIDER:faux", "--var", "FAUX_TOKENS_PER_SECOND:60"],
		{ stdio: ["ignore", "pipe", "pipe"], detached: true },
	);
	let output = "";
	await new Promise((ready, failed) => {
		const seen = (chunk) => {
			output += chunk;
			if (output.includes("Ready on")) ready();
		};
		wrangler.stdout.on("data", seen);
		wrangler.stderr.on("data", seen);
		wrangler.on("exit", () => failed(new Error(`wrangler exited:\n${output}`)));
		const timeout = setTimeout(() => failed(new Error(`wrangler did not start:\n${output.slice(-2000)}`)), 240_000);
		timeout.unref();
	});
}

function stop() {
	wrangler.removeAllListeners("exit");
	try {
		process.kill(-wrangler.pid);
	} catch {}
	return new Promise((done) => setTimeout(done, 1500));
}

before(async () => {
	directory = await mkdtemp(join(tmpdir(), "glav-cloud-"));
	await new Promise((done) => telegram.listen(0, "127.0.0.1", done));
	await start();
});
after(async () => {
	await stop();
	telegram.close();
	await rm(directory, { recursive: true, force: true });
});

let nextUpdate = 1;
function hook(update, secret = SECRET) {
	return fetch(`${worker}/telegram`, {
		method: "POST",
		headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
		body: JSON.stringify({ update_id: nextUpdate++, ...update }),
	});
}
const message = (text, from = 7, chat = from, extra = {}) => ({ message: { from: { id: from }, chat: { id: chat }, text, ...extra } });

async function until(done, what) {
	const deadline = Date.now() + 15_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; calls: ${JSON.stringify(calls.slice(-8))}`);
		await new Promise((tick) => setTimeout(tick, 50));
	}
}
const sent = (chat) => calls.filter((call) => call.method === "sendRichMessage" && !call.failed && (!chat || call.chat_id === String(chat))).map((call) => JSON.parse(call.rich_message).markdown);

/** Send a message and wait for one more reply in that chat. */
async function ask(text, from = 7, chat = from, extra = {}) {
	const before = sent(chat).length;
	const response = await hook(message(text, from, chat, extra));
	assert.equal(response.status, 200);
	await until(() => sent(chat).length > before, `a reply to ${JSON.stringify(text)}`);
	return sent(chat).at(-1);
}

test("only Telegram's secret gets a webhook call in", async () => {
	assert.equal((await hook(message("hi"), null)).status, 401);
	assert.equal((await hook(message("hi"), "wrong")).status, 401);
	assert.equal((await fetch(`${worker}/telegram`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: "{" })).status, 400);
	assert.equal(calls.length, 0);
});

test("cache metrics require operator authorization and expose no conversation content", async () => {
	assert.equal((await fetch(`${worker}/cache?chat=7`, { method: "POST" })).status, 401);
	assert.equal((await fetch(`${worker}/cache?chat=7`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
	assert.equal((await fetch(`${worker}/cache?chat=invalid`, { method: "POST", headers: { authorization: "Bearer setup-secret" } })).status, 400);
	const response = await fetch(`${worker}/cache?chat=7`, { method: "POST", headers: { authorization: "Bearer setup-secret" } });
	assert.equal(response.status, 200);
	const report = await response.json();
	assert.equal(report.requests, 0);
	assert.equal(report.tokenHitRate, 0);
	assert.deepEqual(report.recent, []);
	assert.equal(report.entries, undefined);
});

test("answers an allowed user, once per update", async () => {
	assert.equal(await ask("hello there"), "echo: hello there");
	const before = calls.length;
	nextUpdate--;
	assert.equal((await hook(message("hello there"))).status, 200);
	await new Promise((tick) => setTimeout(tick, 500));
	assert.equal(calls.filter((call, index) => index >= before && call.method === "sendRichMessage").length, 0);
	nextUpdate++;
});

test("strangers cannot run the agent, and unlisted groups get nothing", async () => {
	const before = calls.length;

	await hook(message("allowed user, unlisted group", 7, -100));
	await hook(message("stranger, listed group", 8, -200));
	await hook(message("/start", 8));
	await new Promise((tick) => setTimeout(tick, 300));
	const made = calls.slice(before);
	assert.deepEqual(made.map((call) => call.method), ["sendMessage"]);
	assert.equal(made[0].chat_id, "8");
	assert.match(made[0].text, /free chat messages/);
});

test("an allowed user is answered in a listed group, with typing instead of a draft", async () => {
	assert.equal(await ask("in the group", 7, -200), "echo: in the group");
	assert.ok(calls.some((call) => call.method === "sendChatAction" && call.chat_id === "-200"));
	assert.ok(!calls.some((call) => call.method.includes("Draft") && call.chat_id === "-200"));
});

test("commands", async () => {
	assert.match(await ask("/help"), /\/new - Start a fresh conversation/);
	assert.match(await ask("/model"), /^Model: echo/);
	assert.match(await ask("/model nope"), /^I don't know nope\. Models: echo/);
	assert.match(await ask("/thinking"), /^Thinking: off/);
	assert.equal(await ask("/thinking high"), "Thinking: high");
	assert.match(await ask("/thinking"), /^Thinking: high/);
	assert.equal(await ask("/new"), "Started a fresh conversation.");
	assert.equal(await ask("/stop"), "Nothing is running.");
	assert.match(await ask("/usage"), /faux\/echo: \d+ tokens in/);
});

test("photos reach the model as images and voice notes as text", async () => {
	const answer = await ask(undefined, 7, 7, { caption: "what is this?", photo: [{ file_id: "small" }, { file_id: "large" }] });
	assert.equal(answer, "echo: what is this?\n\n[Image photo.jpg]");
	assert.ok(calls.some((call) => call.method === "getFile" && call.file_id === "large"));
	assert.equal(await ask(undefined, 7, 7, { voice: { file_id: "v", mime_type: "audio/ogg" } }), "echo: [Voice message, transcribed] transcript of 10 bytes");
	const document = await ask(undefined, 7, 7, { document: { file_id: "d", file_name: "report.pdf", mime_type: "application/pdf" } });
	assert.match(document, process.env.GLAV_TEST_NO_COMPUTER
		? /report\.pdf, application\/pdf, \? bytes\. You have nowhere to open it/
		: /report\.pdf, application\/pdf, saved on your computer at \/workspace\/inbox\/\d+_report\.pdf/);
});

test("a file Telegram refuses does not hold the message back", async () => {
	failures.getFile = [{ ok: false, error_code: 400, description: "Bad Request: file is too big" }];
	assert.match(await ask("see this", 7, 7, { photo: [{ file_id: "huge" }] }), /could not be received: telegram 400: Bad Request: file is too big/);
});

test("streams the answer as a draft, and the stop button ends it", async () => {
	const long = "word ".repeat(150).trim();
	const drafts = () => calls.filter((call) => call.method === "sendRichMessageDraft");
	const before = drafts().length;
	assert.equal(await ask(long), `echo: ${long}`);
	const texts = drafts().slice(before).map((call) => JSON.parse(call.rich_message).markdown);
	assert.ok(texts.length >= 2, `only ${texts.length} drafts`);
	assert.ok(texts.every((text) => `echo: ${long}`.startsWith(text)));
	assert.ok(drafts().every((call) => call.can_stop === "true"));

	const stops = sent(7).filter((text) => text === "Stopped.").length;
	const count = drafts().length;
	await hook(message(long));
	await until(() => drafts().length > count, "a draft of the second answer");
	await hook({ stopped_message_generation: { chat: { id: 7 }, draft_id: 1 } });
	await until(() => sent(7).filter((text) => text === "Stopped.").length > stops, "the stop to be confirmed");
	await new Promise((tick) => setTimeout(tick, 500));
	assert.equal(sent(7).at(-1), "Stopped.");
});

test("a send Telegram fails is tried again", async () => {
	failures.sendRichMessage = [{ ok: false, error_code: 500, description: "Internal Server Error" }];
	const attempts = calls.filter((call) => call.method === "sendRichMessage").length;
	assert.equal(await ask("flaky"), "echo: flaky");
	assert.equal(calls.filter((call) => call.method === "sendRichMessage").length, attempts + 2);
});

test("setup points Telegram at the Worker, for the holder of the secret only", async () => {
	assert.equal((await fetch(`${worker}/setup`, { method: "POST" })).status, 401);
	const response = await fetch(`${worker}/setup`, { method: "POST", headers: { authorization: "Bearer setup-secret" } });
	assert.equal(response.status, 200);
	const webhook = calls.find((call) => call.method === "setWebhook");
	assert.equal(webhook.url, `${worker}/telegram`);
	assert.equal(webhook.secret_token, SECRET);
	assert.ok(JSON.parse(webhook.allowed_updates).includes("callback_query"));
	assert.ok(JSON.parse(webhook.allowed_updates).includes("poll"));
	assert.equal(JSON.parse(calls.find((call) => call.method === "setMyCommands").commands)[0].command, "new");
});

test("usage is reported per chat, to the holder of the secret only", async () => {
	assert.equal((await fetch(`${worker}/usage`, { method: "POST" })).status, 401);
	let usage;
	await until(async () => true, "nothing");
	for (let attempt = 0; attempt < 40; attempt++) {
		usage = await (await fetch(`${worker}/usage`, { method: "POST", headers: { authorization: "Bearer setup-secret" } })).json();
		if (usage.chats.length === 2 && usage.chats.find((chat) => chat.chat_id === 7).transcriptions === 1) break;
		await new Promise((tick) => setTimeout(tick, 250));
	}
	const mine = usage.chats.find((chat) => chat.chat_id === 7);
	const group = usage.chats.find((chat) => chat.chat_id === -200);
	// Commands and stops are not messages to the model; a repeated update is counted once.
	assert.equal(group.messages, 1);
	assert.ok(mine.messages >= 7 && mine.messages <= 9, `messages: ${mine.messages}`);
	assert.equal(mine.transcriptions, 1);
	assert.ok(mine.input_tokens > 0 && mine.output_tokens > 0);
	assert.equal(usage.total.chats, 2);
	assert.equal(usage.total.messages, mine.messages + group.messages);
	// With a computer attached, the document started it. Otherwise its usage stays at zero.
	assert.ok(mine.computer_seconds >= 0);
});

const click = (data, from = 7, chat = from) => ({ callback_query: { id: "query-1", from: { id: from }, message: { message_id: 55, chat: { id: chat } }, data } });


test("button clicks reach the conversation with the message ID and are deduplicated", async () => {
	const before = sent(7).length;
	const updateId = nextUpdate;
	assert.equal((await hook(click("show_details"))).status, 200);
	await until(() => sent(7).length > before, "a reply to the button click");
	assert.match(sent(7).at(-1), /Telegram button click/);
	assert.match(sent(7).at(-1), /"message_id":55,"user_id":7,"data":"show_details"/);
	assert.ok(calls.some((call) => call.method === "answerCallbackQuery" && call.callback_query_id === "query-1"));
	nextUpdate = updateId;
	assert.equal((await hook(click("show_details"))).status, 200);
	await new Promise((tick) => setTimeout(tick, 300));
	assert.equal(sent(7).length, before + 1);

	const replies = sent(7).length;
	assert.equal((await hook(click("/new"))).status, 200);
	await until(() => sent(7).length > replies, "a callback that looks like a command");
	assert.match(sent(7).at(-1), /Telegram button click/);
	assert.match(sent(7).at(-1), /"data":"\/new"/);
});

test("button clicks require both an allowed sender and an allowed chat", async () => {
	const before = calls.length;
	await hook(click("show_details", 8, 7));
	await hook(click("show_details", 7, -100));
	await hook({ callback_query: { id: "inline-query", from: { id: 7 }, inline_message_id: "elsewhere", data: "show_details" } });
	await new Promise((tick) => setTimeout(tick, 300));
	assert.equal(calls.length, before);

	const replies = sent(-200).length;
	await hook(click("group_details", 7, -200));
	await until(() => sent(-200).length > replies, "a group button reply");
	assert.match(sent(-200).at(-1), /"data":"group_details"/);
});

test("after a restart, an update already answered is not answered again", async () => {
	const update = nextUpdate;
	assert.equal(await ask("before the restart"), "echo: before the restart");
	await stop();
	await start();
	const before = sent(7).length;
	nextUpdate = update;
	assert.equal((await hook(message("before the restart"))).status, 200);
	assert.equal(await ask("after the restart"), "echo: after the restart");
	assert.equal(sent(7).length, before + 1);
});

test("answers from updated anonymous poll totals without replying to every vote", async () => {
	const poll = { id: "demo-poll", question: "Which UI next?", options: [{ text: "Callback buttons", voter_count: 0 }, { text: "Expandable details", voter_count: 0 }], total_voter_count: 0, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false };
	await ask("Remember this poll", 7, 7, { message_id: 72, poll });
	const replies = sent(7).length;
	const update = nextUpdate;
	const voted = { ...poll, options: [{ text: "Callback buttons", voter_count: 1 }, poll.options[1]], total_voter_count: 1 };
	assert.equal((await hook({ poll: voted })).status, 200);
	await new Promise((tick) => setTimeout(tick, 150));
	assert.equal(sent(7).length, replies, "a vote updates state without an unsolicited reply");
	const answer = await ask("Use the poll results");
	assert.match(answer, /"total_voter_count":1/);
	assert.match(answer, /"text":"Callback buttons","voter_count":1/);
	// Telegram can embed an old snapshot when replying to or clicking a poll message.
	assert.equal(await ask("Use the results from this reply", 7, 7, { reply_to_message: { message_id: 72, poll } }), "echo: Use the results from this reply", "unchanged totals are already in the conversation");
	// A late retry of an older zero-vote update must not replace the newer totals.
	nextUpdate = update - 1;
	await hook({ poll });
	nextUpdate = update + 4;
	assert.equal(await ask("Read the poll again"), "echo: Read the poll again");
	await stop();
	await start();
	assert.equal(await ask("Read the poll after restart"), "echo: Read the poll after restart", "restart preserves the observation already in history");
	const status = await (await fetch(`${worker}/status?chat=7`, { method: "POST", headers: { authorization: "Bearer setup-secret" } })).json();
	assert.equal(status.polls[0].poll.total_voter_count, 1, "old Message.poll and older updates never roll back the stored observation");
	await ask("/new");
	assert.match(await ask("Read the poll in a fresh conversation"), /"total_voter_count":1/, "a reset receives the latest snapshot again");
	// A message in another allowed chat must not acquire this private chat's poll observations.
	assert.equal(await ask("Read the polls in this group", 7, -200), "echo: Read the polls in this group");
});

async function issueCodes(count = 1) {
	const response = await fetch(`${worker}/trial-codes`, { method: "POST", headers: { authorization: "Bearer setup-secret" }, body: JSON.stringify({ count }) });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	return (await response.json()).codes;
}

test("only the operator can generate codes, and invalid candidates never reach the model", async () => {
	assert.equal((await fetch(`${worker}/trial-codes`, { method: "POST", body: "{}" })).status, 401);
	assert.equal((await fetch(`${worker}/trial-codes`, { method: "POST", headers: { authorization: "Bearer setup-secret" }, body: '{"count":101}' })).status, 400);
	const before = calls.length;
	await hook(message(`Please activate GLAV-${"0".repeat(32)}`, 101, 101, { voice: { file_id: "no-download" } }));
	assert.deepEqual(calls.slice(before).map((call) => call.method), ["sendMessage"]);
	assert.match(calls.at(-1).text, /cannot activate a trial/);
});

test("a trial code in conversation activates once, persists across restart, and stays private", async () => {
	const [code] = await issueCodes();
	const before = calls.length;
	const answer = await ask(`Here is my trial code ${code.toLowerCase()}, please activate it.`, 102, 102, { voice: { file_id: "no-download" } });
	assert.match(answer, /active/);
	assert.ok(!calls.slice(before).some((call) => call.method === "getFile"), "redemption cannot download or transcribe attachments");
	const status = async () => (await (await fetch(`${worker}/status?chat=102`, { method: "POST", headers: { authorization: "Bearer setup-secret" } })).json()).trial;
	const grant = await status();
	assert.equal(grant.endsAt - grant.startedAt, 86_400_000);
	assert.equal(await ask("hello on the trial", 102), "echo: hello on the trial");
	assert.match(await ask(`Try ${code} again`, 102), /active/);
	assert.deepEqual(await status(), grant, "a replay does not extend expiry");
	const beforeGroup = calls.length;
	await hook(message("trial in a listed group", 102, -200));
	await hook(click("details", 102, -200));
	await hook(message(`Activate ${code}`, 103));
	assert.equal(calls.slice(beforeGroup).filter((call) => call.method === "sendMessage").length, 1);
	assert.equal(calls.at(-1).chat_id, "103");
	assert.match(calls.at(-1).text, /cannot activate a trial/);
	const replies = sent(102).length;
	await hook(click("trial_details", 102));
	await until(() => sent(102).length > replies, "a trial user's button reply");
	await stop();
	await start();
	assert.equal(await ask("trial after restart", 102), "echo: trial after restart");
	assert.deepEqual(await status(), grant);
});

test("simultaneous conversations redeem a code for exactly one account", async () => {
	const [code] = await issueCodes();
	const before = calls.length;
	await Promise.all([hook(message(`Activate ${code}`, 104)), hook(message(`Activate ${code}`, 105))]);
	await until(() => calls.slice(before).filter((call) => ["sendMessage", "sendRichMessage"].includes(call.method) && ["104", "105"].includes(call.chat_id)).length >= 2, "both redemption results");
	const grants = await Promise.all([104, 105].map(async (chat) => (await (await fetch(`${worker}/status?chat=${chat}`, { method: "POST", headers: { authorization: "Bearer setup-secret" } })).json()).trial));
	assert.equal(grants.filter(Boolean).length, 1);
	const winner = grants[0] ? 104 : 105;
	assert.equal(await ask("I have access", winner), "echo: I have access");
});

test("an expired trial denies messages and callbacks and cannot consume another code", async () => {
	const [code, another] = await issueCodes(2);
	assert.match(await ask(`Activate ${code}`, 106), /active/);
	await promisify(execFile)("npx", ["wrangler", "d1", "execute", "glav", "--local", "--persist-to", directory,
		"--command", "UPDATE trial_access SET ends_at = 0 WHERE user_id = 106"], { timeout: 30_000 });
	const before = calls.length;
	await hook(message("keep working", 106, 106, { voice: { file_id: "no-expired-download" } }));
	await hook(click("expired_details", 106));
	await hook(message(`Activate ${another}`, 106));
	const made = calls.slice(before);
	assert.deepEqual(made.map((call) => call.method), ["sendMessage", "sendMessage"]);
	assert.ok(made.every((call) => /trial has ended/.test(call.text)));
	assert.match(await ask(`Activate ${another}`, 107), /active/, "the ineligible user did not consume the other code");
});

test("the launch campaign can issue only 100 codes across batches", async () => {
	const issue = (count) => fetch(`${worker}/trial-codes`, { method: "POST", headers: { authorization: "Bearer setup-secret" }, body: JSON.stringify({ count }) });
	const first = await (await issue(1)).json();
	assert.ok(first.remaining > 0 && first.remaining < 99);
	const response = await issue(first.remaining);
	assert.equal(response.status, 200);
	const last = await response.json();
	assert.equal(last.remaining, 0);
	const refused = await issue(1);
	assert.equal(refused.status, 409);
	assert.equal((await refused.json()).remaining, 0);
	assert.match(await ask(`Activate ${last.codes[0]}`, 108), /active/, "issued codes remain redeemable after issuance closes");
	assert.equal((await issue(1)).status, 409, "consuming a code never restores issuance capacity");
});

async function operator(route, body = {}) {
	const response = await fetch(`${worker}/${route}`, { method: "POST", headers: { authorization: "Bearer setup-secret" }, body: JSON.stringify(body) });
	assert.equal(response.status, 200, await response.clone().text());
	return response.json();
}
const account = (chat) => operator(`status?chat=${chat}`);

test("free users can talk immediately, use exactly 20 messages, and never download files or start a computer", async () => {
	assert.equal((await fetch(`${worker}/access-settings`, { method: "POST", body: '{}' })).status, 401);
	await operator("access-settings", { freeMessages: 20, betaMode: true });
	const before = calls.length;
	assert.equal(await ask("Hey", 201, 201, { from: { id: 201, first_name: "Kaloyan" }, voice: { file_id: "never-download-free" } }), "echo: Hey");
	assert.equal((await account(201)).access.freeRemaining, 19);
	assert.equal((await account(201)).access.waitlisted, true);
	assert.equal(await ask("/new", 201), "Started a fresh conversation.");
	assert.equal((await account(201)).access.freeRemaining, 18, "conversation resets retain the allowance");
	await stop(); await start();
	for (let index = 3; index <= 20; index++) assert.equal(await ask(`Free chat ${index}`, 201), `echo: Free chat ${index}`);
	const status = await account(201);
	assert.equal(status.access.freeUsed, 20);
	assert.equal(status.access.agent, false);
	assert.ok(!status.computer.running);
	assert.ok(!calls.slice(before).some((call) => call.method === "getFile"));
	const sentBefore = sent(201).length;
	nextUpdate--;
	await hook(message("Free chat 20", 201));
	await new Promise((tick) => setTimeout(tick, 200));
	assert.equal(sent(201).length, sentBefore, "the twentieth message retry is not charged or answered twice");
	assert.equal((await account(201)).access.freeUsed, 20);
	nextUpdate++;
	await hook(message("A twenty-first message", 201));
	assert.match(calls.at(-1).text, /20 free chat messages/);
	assert.equal(sent(201).length, sentBefore, "over-quota messages do not reach the model");
	assert.equal((await account(201)).access.freeUsed, 20);
	assert.equal((await operator("waitlist")).waiting, 1);
});

test("a separate three-day trial can activate after free chat ends, and beta can be retired independently", async () => {
	await operator("campaigns", { id: "standard", purpose: "Standard trial", durationDays: 3, limit: 2 });
	const issued = await operator("trial-codes", { campaign: "standard", count: 2 });
	assert.equal(issued.durationDays, 3);
	assert.match(await ask(`Activate ${issued.codes[0]}`, 201), /active/);
	const granted = await account(201);
	assert.equal(granted.trial.endsAt - granted.trial.startedAt, 3 * 86_400_000);
	assert.equal(granted.access.freeUsed, 20, "redemption does not spend a free message");
	assert.equal((await operator("waitlist")).waiting, 0);
	assert.equal(await ask("Do my agent work", 201), "echo: Do my agent work");
	await operator("access-settings", { betaMode: false });
	await operator("campaigns", { id: "launch", enabled: false });
	assert.equal(await ask("Hey without beta", 202), "echo: Hey without beta");
	const next = await account(202);
	assert.equal(next.access.settings.betaMode, false);
	assert.equal(next.access.campaign, undefined);
	assert.equal(next.access.waitlisted, false);
	assert.equal(next.access.agent, false);
	assert.equal((await account(201)).access.agent, true, "beta retirement does not revoke active trials");
});

test("subscriptions require operator verification and retire at their backend expiry", async () => {
	assert.equal((await fetch(`${worker}/subscriptions`, { method: "POST", body: JSON.stringify({ userId: 203, endsAt: Date.now() + 86_400_000 }) })).status, 401);
	await operator("subscriptions", { userId: 203, endsAt: Date.now() + 86_400_000, reference: "test-payment" });
	assert.equal(await ask("Subscribed work", 203), "echo: Subscribed work");
	assert.equal((await account(203)).access.tier, "subscription");
	await operator("subscriptions", { userId: 203, endsAt: 0 });
	assert.equal((await account(203)).access.tier, "free");
	await operator("access-settings", { codesEnabled: false });
	assert.equal((await fetch(`${worker}/trial-codes`, { method: "POST", headers: { authorization: "Bearer setup-secret" }, body: JSON.stringify({ campaign: "standard" }) })).status, 409);
});


test("free users can stop streaming replies without spending another free message", async () => {
	await hook(message("A long free reply ".repeat(150), 204));
	await until(() => calls.some((call) => call.method === "sendMessageDraft" && call.chat_id === "204"), "a free user's draft");
	await hook({ stopped_message_generation: { chat: { id: 204 } } });
	await until(() => sent(204).includes("Stopped."), "a free stop acknowledgement");
	assert.equal((await account(204)).access.freeUsed, 1);
	assert.equal((await account(204)).access.agent, false);
});
