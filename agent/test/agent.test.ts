import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { type AgentOptions, COMMANDS, type RunningAgent, startAgent } from "../src/agent.ts";

type Sent = { chat_id: number; text: string };

type Drafted = { chat_id: number; draft_id: number; text: string };

/** Stand-in for the Go transport. `statuses` are answered to /send first, then 200. */
function fakeTransport(statuses: number[] = []) {
	const sent: Sent[] = [];
	const unauthorized: string[] = [];
	const drafts: Drafted[] = [];
	const voices: { chat_id: number; path: string; caption?: string; audio: string }[] = [];
	const commands: unknown[] = [];
	let attempts = 0;
	const waiters: (() => void)[] = [];
	const server: Server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		if (request.headers.authorization !== "Bearer s3cret") unauthorized.push(request.url ?? "");
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (request.url !== "/send") {
			if (request.url === "/draft") drafts.push(body);
			else if (request.url === "/voice") voices.push({ ...body, audio: await readFile(body.path, "utf8") });
			else commands.push(body);
			response.end();
			for (const wake of waiters.splice(0)) wake();
			return;
		}
		attempts++;
		const status = statuses.shift() ?? 200;
		if (status === 200) sent.push(body);
		response.writeHead(status).end(status === 200 ? "" : "refused");
		for (const wake of waiters.splice(0)) wake();
	});
	return {
		sent,
		unauthorized,
		drafts,
		voices,
		commands,
		attempts: () => attempts,
		async listen() {
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			server.unref();
			return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		},
		/** Resolve once `done()` holds, checked after every request. */
		async until(done: () => boolean) {
			const deadline = Date.now() + 10_000;
			while (!done()) {
				if (Date.now() > deadline) throw new Error("timed out waiting for the transport");
				await Promise.race([new Promise<void>((wake) => waiters.push(wake)), new Promise((tick) => setTimeout(tick, 200))]);
			}
		},
		close: () => new Promise((done) => server.close(done)),
	};
}

let directory: string;
before(async () => {
	directory = await mkdtemp(join(tmpdir(), "glav-agent-"));
});
after(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function start(name: string, transportUrl: string, extra: Partial<AgentOptions> = {}) {
	const faux = fauxProvider({ tokensPerSecond: extra.draftIntervalMs ? 200 : undefined });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const agent = await startAgent({
		storage: await openNodeSqliteStorage(join(directory, `${name}.sqlite`)),
		models,
		provider: model.provider,
		modelId: model.id,
		instructions: "test",
		transportUrl,
		secret: "s3cret",
		host: "127.0.0.1",
		port: 0,
		maxSendWaitMs: 50,
		...extra,
	});
	return { agent, faux };
}

function inbound(agent: RunningAgent, body: unknown) {
	return fetch(`http://127.0.0.1:${agent.port}/inbound`, {
		method: "POST",
		headers: { authorization: "Bearer s3cret" },
		body: JSON.stringify(body),
	});
}

test("answers a message and sends the reply to the transport", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("answer", await transport.listen());
	faux.setResponses([fauxAssistantMessage("pong")]);

	const response = await inbound(agent, { update_id: 1, chat_id: 42, text: "ping" });
	assert.equal(response.status, 200);
	await transport.until(() => transport.sent.length === 1);
	assert.deepEqual(transport.sent, [{ chat_id: 42, text: "pong" }]);

	await agent.close();
	await transport.close();
});

test("a re-forwarded update is answered once", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("dedupe", await transport.listen());
	faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

	assert.equal((await inbound(agent, { update_id: 7, chat_id: 1, text: "hi" })).status, 200);
	assert.equal((await inbound(agent, { update_id: 7, chat_id: 1, text: "hi" })).status, 200);
	await transport.until(() => transport.sent.length === 1);
	// Again after delivery, as after a transport restart.
	assert.equal((await inbound(agent, { update_id: 7, chat_id: 1, text: "hi" })).status, 200);
	assert.equal((await inbound(agent, { update_id: 8, chat_id: 1, text: "next" })).status, 200);
	await transport.until(() => transport.sent.length === 2);

	assert.deepEqual(transport.sent, [
		{ chat_id: 1, text: "one" },
		{ chat_id: 1, text: "two" },
	]);
	assert.equal(faux.state.callCount, 2);

	await agent.close();
	await transport.close();
});

test("each chat has its own conversation", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("chats", await transport.listen());
	const seen: number[] = [];
	const countUserMessages = (context: { messages: { role: string }[] }) => {
		seen.push(context.messages.filter((message) => message.role === "user").length);
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([countUserMessages, countUserMessages, countUserMessages]);

	await inbound(agent, { update_id: 1, chat_id: 10, text: "a" });
	await transport.until(() => transport.sent.length === 1);
	await inbound(agent, { update_id: 2, chat_id: 20, text: "b" });
	await transport.until(() => transport.sent.length === 2);
	await inbound(agent, { update_id: 3, chat_id: 10, text: "c" });
	await transport.until(() => transport.sent.length === 3);

	assert.deepEqual(seen, [1, 1, 2]);
	assert.deepEqual(
		transport.sent.map((message) => message.chat_id),
		[10, 20, 10],
	);

	await agent.close();
	await transport.close();
});

test("retries a failed send, and gives up on a permanent refusal", async () => {
	const transport = fakeTransport([503, 502, 200, 422]);
	const { agent, faux } = await start("retry", await transport.listen());
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("refused"), fauxAssistantMessage("third")]);

	await inbound(agent, { update_id: 1, chat_id: 5, text: "a" });
	await transport.until(() => transport.sent.length === 1);
	assert.equal(transport.attempts(), 3);

	await inbound(agent, { update_id: 2, chat_id: 5, text: "b" });
	await transport.until(() => transport.attempts() === 4);
	await inbound(agent, { update_id: 3, chat_id: 5, text: "c" });
	await transport.until(() => transport.sent.length === 2);

	assert.equal(transport.attempts(), 5);
	assert.deepEqual(
		transport.sent.map((message) => message.text),
		["first", "third"],
	);

	await agent.close();
	await transport.close();
});

test("a reply still owed at shutdown is sent by the next process, without asking the model again", async () => {
	const down = fakeTransport(Array(1000).fill(503));
	const first = await start("restart", await down.listen());
	first.faux.setResponses([fauxAssistantMessage("survived")]);

	assert.equal((await inbound(first.agent, { update_id: 1, chat_id: 9, text: "hello" })).status, 200);
	await down.until(() => down.attempts() >= 2);
	await first.agent.close();
	await down.close();

	const up = fakeTransport();
	const second = await start("restart", await up.listen());
	await up.until(() => up.sent.length === 1);
	assert.deepEqual(up.sent, [{ chat_id: 9, text: "survived" }]);
	assert.equal(second.faux.state.callCount, 0);

	// The transport forwards the update again after its own restart: nothing new is sent.
	assert.equal((await inbound(second.agent, { update_id: 1, chat_id: 9, text: "hello" })).status, 200);
	await second.agent.close();
	assert.equal(up.sent.length, 1);
	await up.close();
});

test("rejects malformed input", async () => {
	const transport = fakeTransport();
	const { agent } = await start("invalid", await transport.listen());

	assert.equal((await inbound(agent, { update_id: 1, chat_id: 2 })).status, 400);
	assert.equal((await inbound(agent, { update_id: "1", chat_id: 2, text: "x" })).status, 400);
	const raw = (body: string, authorization: string) =>
		fetch(`http://127.0.0.1:${agent.port}/inbound`, { method: "POST", headers: { authorization }, body });
	assert.equal((await raw("{", "Bearer s3cret")).status, 400);
	assert.equal((await fetch(`http://127.0.0.1:${agent.port}/inbound`)).status, 404);

	await agent.close();
	await transport.close();
});

test("a message sent while the agent works joins that work and gets one shared answer", async () => {
	const transport = fakeTransport();
	const workspace = join(directory, "steer-workspace");
	await mkdir(workspace, { recursive: true });
	const { agent, faux } = await start("steer", await transport.listen(), { workspace });
	let userMessages = 0;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.4" })], { stopReason: "toolUse" }),
		(context) => {
			userMessages = context.messages.filter((message) => message.role === "user").length;
			return fauxAssistantMessage("both handled");
		},
	]);

	await inbound(agent, { update_id: 1, chat_id: 3, text: "first" });
	await new Promise((tick) => setTimeout(tick, 150));
	await inbound(agent, { update_id: 2, chat_id: 3, text: "actually, also this" });
	await transport.until(() => transport.sent.length === 1);
	await agent.close();

	assert.equal(userMessages, 2);
	assert.deepEqual(transport.sent, [{ chat_id: 3, text: "both handled" }]);
	await transport.close();
});

test("uses the computer through its tools, in the workspace", async () => {
	const transport = fakeTransport();
	const workspace = join(directory, "tools-workspace");
	await mkdir(workspace, { recursive: true });
	await writeFile(join(workspace, "marker.txt"), "x");
	const { agent, faux } = await start("tools", await transport.listen(), { workspace, draftIntervalMs: 20 });
	let toolResult = "";
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls; sleep 0.2" })], { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			toolResult = JSON.stringify(result?.content);
			return fauxAssistantMessage("listed");
		},
	]);

	await inbound(agent, { update_id: 1, chat_id: 4, text: "ls" });
	await transport.until(() => transport.sent.length === 1);
	await agent.close();

	assert.match(toolResult, /marker\.txt/);
	// While the command ran, the draft said so.
	assert.ok(transport.drafts.some((draft) => draft.text.includes("bash: `ls; sleep 0.2`")), JSON.stringify(transport.drafts));
	await transport.close();
});

test("streams the answer as a draft before sending it", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("stream", await transport.listen(), { draftIntervalMs: 20 });
	const answer = "word ".repeat(120).trim();
	faux.setResponses([fauxAssistantMessage(answer)]);

	await inbound(agent, { update_id: 1, chat_id: 6, text: "talk" });
	await transport.until(() => transport.sent.length === 1);
	await agent.close();

	const texts = transport.drafts.map((draft) => draft.text);
	assert.ok(texts.length >= 3, `only ${texts.length} drafts`);
	assert.equal(new Set(transport.drafts.map((draft) => draft.draft_id)).size, 1);
	assert.ok(texts.some((text) => text.length > 0 && text.length < answer.length && answer.startsWith(text)));
	assert.deepEqual(transport.sent, [{ chat_id: 6, text: answer }]);
	await transport.close();
});

test("hands over photos as images, voice notes as text, and other files by path", async () => {
	const transport = fakeTransport();
	const photo = join(directory, "photo.jpg");
	await writeFile(photo, "jpeg bytes");
	const { agent, faux } = await start("media", await transport.listen(), {
		transcribe: async (path) => `transcript of ${path}`,
	});
	const seen: unknown[] = [];
	const record = (context: { messages: { role: string; content: unknown }[] }) => {
		seen.push(context.messages.findLast((message) => message.role === "user")?.content);
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([record, record]);

	await inbound(agent, {
		update_id: 1,
		chat_id: 8,
		text: "what is this?",
		attachments: [{ kind: "photo", path: photo, name: "photo.jpg", mime: "image/jpeg", size: 10 }],
	});
	await transport.until(() => transport.sent.length === 1);
	await inbound(agent, {
		update_id: 2,
		chat_id: 8,
		attachments: [
			{ kind: "voice", path: "/inbox/voice.ogg", name: "voice.ogg", mime: "audio/ogg" },
			{ kind: "document", path: "/inbox/report.pdf", name: "report.pdf", mime: "application/pdf", size: 5 },
			{ kind: "video", name: "big.mp4", error: "file is too big" },
		],
	});
	await transport.until(() => transport.sent.length === 2);
	await agent.close();

	const first = seen[0] as { type: string; text?: string; data?: string; mimeType?: string }[];
	assert.match(first[0]!.text!, /^what is this\?/);
	assert.deepEqual(first[1], { type: "image", data: Buffer.from("jpeg bytes").toString("base64"), mimeType: "image/jpeg" });
	const second = seen[1] as string;
	assert.match(second, /transcript of \/inbox\/voice\.ogg/);
	assert.match(second, /report\.pdf, application\/pdf, 5 bytes, saved at \/inbox\/report\.pdf/);
	assert.match(second, /big\.mp4\) that could not be received: file is too big/);
	await transport.close();
});

test("commands", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("commands", await transport.listen());
	const said = async (text: string) => {
		const before = transport.sent.length;
		assert.equal((await inbound(agent, { update_id: 100 + before, chat_id: 2, text })).status, 200);
		await transport.until(() => transport.sent.length > before);
		return transport.sent.at(-1)!.text;
	};
	const userMessages: number[] = [];
	const count = (context: { messages: { role: string }[] }) => {
		userMessages.push(context.messages.filter((message) => message.role === "user").length);
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([count, count, count]);

	await transport.until(() => transport.commands.length === 1);
	assert.deepEqual(transport.commands[0], COMMANDS);
	assert.match(await said("/help"), /\/new - Start a fresh conversation/);
	assert.equal(await said("/usage"), "Nothing used yet.");

	assert.equal(await said("one"), "ok");
	assert.equal(await said("two"), "ok");
	assert.equal(await said("/new"), "Started a fresh conversation.");
	assert.equal(await said("three"), "ok");
	assert.deepEqual(userMessages, [1, 2, 1]);
	assert.match(await said("/usage"), /faux\/.* tokens in, .* out, \$/);

	assert.match(await said("/model"), /^Model: faux\//);
	assert.match(await said("/model nope"), /^I don't know faux\/nope\. Models of faux: /);
	assert.equal(await said(`/model ${faux.getModel().id}`), `Model: faux/${faux.getModel().id}`);
	assert.match(await said("/thinking"), /^Thinking: off/);
	assert.match(await said("/thinking loud"), /^Levels: off, minimal/);
	assert.equal(await said("/thinking high"), "Thinking: high");
	assert.match(await said("/thinking"), /^Thinking: high/);
	assert.equal(await said("/stop"), "Nothing is running.");

	await agent.close();
	await transport.close();
});

test("stop ends the run without an apology, from the command or the draft's button", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("stop", await transport.listen(), { draftIntervalMs: 20 });
	faux.setResponses([fauxAssistantMessage("slow ".repeat(2000)), fauxAssistantMessage("slow ".repeat(2000)), fauxAssistantMessage("after")]);

	await inbound(agent, { update_id: 1, chat_id: 11, text: "go" });
	await transport.until(() => transport.drafts.length > 1);
	await inbound(agent, { update_id: 2, chat_id: 11, text: "/stop" });
	await transport.until(() => transport.sent.length === 1);

	await inbound(agent, { update_id: 3, chat_id: 11, text: "go again" });
	await transport.until(() => transport.drafts.at(-1)?.draft_id !== transport.drafts[0]!.draft_id);
	await inbound(agent, { update_id: 4, chat_id: 11, stop: true });
	await transport.until(() => transport.sent.length === 2);

	await inbound(agent, { update_id: 5, chat_id: 11, text: "and now?" });
	await transport.until(() => transport.sent.length === 3);
	await agent.close();

	assert.deepEqual(
		transport.sent.map((message) => message.text),
		["Stopped.", "Stopped.", "after"],
	);
	await transport.close();
});

test("takes messages only with the shared secret, and sends it to the transport", async () => {
	const transport = fakeTransport();
	const { agent, faux } = await start("secret", await transport.listen());
	faux.setResponses([fauxAssistantMessage("ok")]);
	const message = JSON.stringify({ update_id: 1, chat_id: 2, text: "rm -rf" });
	const url = `http://127.0.0.1:${agent.port}/inbound`;

	// What a web page can send without a preflight: no custom header.
	assert.equal((await fetch(url, { method: "POST", body: message })).status, 401);
	assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer guess!" }, body: message })).status, 401);
	assert.equal((await fetch(url, { method: "POST", headers: { authorization: "s3cret" }, body: message })).status, 401);
	assert.equal(faux.state.callCount, 0);

	assert.equal((await inbound(agent, { update_id: 1, chat_id: 2, text: "hi" })).status, 200);
	await transport.until(() => transport.sent.length === 1 && transport.commands.length === 1);
	await agent.close();
	assert.deepEqual(transport.unauthorized, []);
	await transport.close();
});

test("/tts answers with voice messages, with the words as caption, until turned off", async () => {
	const transport = fakeTransport();
	const workspace = join(directory, "tts-workspace");
	await mkdir(workspace, { recursive: true });
	const { agent, faux } = await start("tts", await transport.listen(), {
		workspace,
		speak: async (text) => new TextEncoder().encode(`spoken: ${text.slice(0, 20)}`),
	});
	const long = "long answer ".repeat(100).trim();
	const prompts: string[] = [];
	// Changes to the prompt and the offered tools travel as the newest system message.
	const answer = (text: string) => (context: { messages: { role: string }[] }) => {
		const system = JSON.stringify(context.messages.findLast((message) => message.role === "system"));
		const offered = system.includes("send_text") && !system.includes('"toolsRemoved":[{"name":"send_text"}]');
		prompts.push(`${system.includes("Voice mode is on") ? "voice" : "text"}:${offered ? "tool" : "no tool"}`);
		return fauxAssistantMessage(text);
	};
	faux.setResponses([answer("first"), answer("second"), answer(long), answer("fourth")]);
	const ask = async (update_id: number, text: string, done: () => boolean) => {
		await inbound(agent, { update_id, chat_id: 12, text });
		await transport.until(done);
	};

	await ask(1, "hi", () => transport.sent.length === 1);
	await ask(2, "/tts", () => transport.sent.length === 2);
	await ask(3, "hi", () => transport.voices.length === 1);
	await ask(4, "hi", () => transport.voices.length === 2 && transport.sent.length === 3);
	await ask(5, "/tts off", () => transport.sent.length === 4);
	await ask(6, "hi", () => transport.sent.length === 5);
	await agent.close();

	// A short answer is the voice message alone; a long one is followed by its text.
	assert.deepEqual(
		transport.sent.map((message) => message.text),
		["first", "Voice mode on. I'll answer with voice messages, and send code and the like as text.", long, "Voice mode off.", "fourth"],
	);
	assert.deepEqual(
		transport.voices.map((voice) => [voice.chat_id, voice.caption, voice.audio]),
		[
			[12, "second", "spoken: second"],
			[12, undefined, "spoken: long answer long ans"],
		],
	);
	assert.deepEqual(prompts, ["text:no tool", "voice:tool", "voice:tool", "text:no tool"]);
	assert.ok(transport.voices[0]!.path.startsWith(join(workspace, "outbox")));
	// The files are removed once handed over.
	assert.deepEqual(await readdir(join(workspace, "outbox")), []);
	await transport.close();
});

test("in voice mode, sends what does not work in speech as text and falls back to text without a voice", async () => {
	const transport = fakeTransport();
	const workspace = join(directory, "voice-workspace");
	await mkdir(workspace, { recursive: true });
	let broken = false;
	const { agent, faux } = await start("voice", await transport.listen(), {
		workspace,
		speak: async (text) => {
			if (broken) throw new Error("no voice today");
			return new TextEncoder().encode(text);
		},
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("send_text", { markdown: "```sh\nls -la\n```" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("I sent you the command as text."),
		fauxAssistantMessage("Spoken, but the voice is down."),
	]);

	await inbound(agent, { update_id: 1, chat_id: 13, text: "/tts on" });
	await transport.until(() => transport.sent.length === 1);
	await inbound(agent, { update_id: 2, chat_id: 13, text: "how do I list files?" });
	await transport.until(() => transport.voices.length === 1);
	broken = true;
	await inbound(agent, { update_id: 3, chat_id: 13, text: "again" });
	await transport.until(() => transport.sent.length === 3);
	await agent.close();

	assert.deepEqual(
		transport.sent.slice(1).map((message) => message.text),
		["```sh\nls -la\n```", "Spoken, but the voice is down."],
	);
	assert.deepEqual(
		transport.voices.map((voice) => voice.caption),
		["I sent you the command as text."],
	);
	await transport.close();
});
