import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";

import { Telegram } from "../src/telegram.ts";
import { TELEGRAM_PROMPT, telegramReplyNeeded, telegramTools } from "../src/telegram-tools.ts";

test("the model sends rich UI in its chat, receives message IDs, and edits the UI", async (t) => {
	const calls = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const method = request.url.split("/").at(-1);
		calls.push({ method, ...Object.fromEntries(new URLSearchParams(body)) });
		response.end(JSON.stringify(method === "sendPhoto"
			? { ok: false, error_code: 400, description: "Bad Request: invalid photo" }
			: { ok: true, result: { message_id: 55, chat: { id: 7 } } }));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise((done) => server.close(done)));
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	// Installed after Harness.open, as in Chat, and available without a computer.
	registry.install(telegramTools(new Telegram("TOKEN", `http://127.0.0.1:${server.address().port}`), (work) => work(7)));
	const conversation = await harness.root(context);
	await conversation.configure({ model: { provider: "faux", modelId: faux.getModel().id }, instructions: TELEGRAM_PROMPT }, context);
	harness.resume();

	async function invoke(method, params_json) {
		let result;
		faux.appendResponses([
			fauxAssistantMessage(fauxToolCall("telegram", { method, params_json }), { stopReason: "toolUse" }),
			(transcript) => {
				result = transcript.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage("done");
			},
		]);
		const submission = await conversation.submit({ type: "input", content: "Send something to this chat." }, context);
		assert.equal((await submission.wait(context)).status, "done");
		return result;
	}

	const rich_message = { blocks: [
		{ type: "heading", size: 2, text: "Choose a view" },
		{ type: "details", summary: "Details", blocks: [{ type: "paragraph", text: "More information" }] },
		{ type: "buttons", buttons: [{ text: "Show details", callback_data: "show_details", style: "primary" }] },
	] };
	const reply_markup = { inline_keyboard: [[{ text: "Refresh", callback_data: "refresh" }]] };
	const result = await invoke("sendRichMessage", JSON.stringify({ rich_message, reply_markup, disable_notification: true }));
	assert.equal(result.isError, false);
	assert.equal(JSON.parse(result.content[0].text).message_id, 55);
	assert.equal(calls[0].method, "sendRichMessage");
	assert.equal(calls[0].chat_id, "7");
	assert.deepEqual(JSON.parse(calls[0].rich_message), rich_message);
	assert.deepEqual(JSON.parse(calls[0].reply_markup), reply_markup);
	assert.equal(calls[0].disable_notification, "true");

	assert.equal((await invoke("editMessageText", JSON.stringify({ message_id: 55, rich_message: { markdown: "Updated" }, reply_markup: { inline_keyboard: [] } }))).isError, false);
	assert.equal(calls[1].chat_id, "7");
	assert.equal(calls[1].message_id, "55");
	assert.deepEqual(JSON.parse(calls[1].rich_message), { markdown: "Updated" });

	for (const key of ["chat_id", "inline_message_id", "business_connection_id"]) {
		const refused = await invoke("sendMessage", JSON.stringify({ text: "wrong destination", [key]: "999" }));
		assert.equal(refused.isError, true);
		assert.match(JSON.stringify(refused.content), /current chat/);
	}
	assert.equal((await invoke("setWebhook", "{}")).isError, true);
	assert.equal((await invoke("sendMessage", "[]")).isError, true);
	assert.equal((await invoke("sendMessage", "{invalid")).isError, true);
	assert.equal(calls.length, 2, "invalid requests never reach Telegram");

	const failed = await invoke("sendPhoto", JSON.stringify({ photo: "bad" }));
	assert.equal(failed.isError, true);
	assert.match(JSON.stringify(failed.content), /telegram 400: Bad Request: invalid photo/);
});

test("a Telegram tool reply is delivered once, while ordinary and failed-tool replies still get a final answer", async (t) => {
	const calls = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const method = request.url.split("/").at(-1);
		calls.push({ method, failed: method === "sendPhoto", ...Object.fromEntries(new URLSearchParams(body)) });
		response.end(JSON.stringify(method === "sendPhoto"
			? { ok: false, error_code: 400, description: "Bad Request: invalid photo" }
			: { ok: true, result: { message_id: 55, chat: { id: 7 } } }));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise((done) => server.close(done)));
	const telegram = new Telegram("TOKEN", `http://127.0.0.1:${server.address().port}`);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(telegramTools(telegram, (work) => work(7)));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	await conversation.configure({ model: { provider: "faux", modelId: faux.getModel().id }, instructions: TELEGRAM_PROMPT }, context);
	harness.resume();

	for (const method of ["sendMessage", "sendRichMessage", "sendPoll", "editMessageText", "sendPhoto", "badMethod", undefined]) {
		const before = calls.filter((call) => !call.failed).length;
		faux.appendResponses([
			...(method ? [fauxAssistantMessage(fauxToolCall("telegram", { method, params_json: JSON.stringify({ text: "Here is the answer" }) }), { stopReason: "toolUse" })] : []),
			fauxAssistantMessage("Here is the answer again"),
		]);
		const submission = await conversation.submit({ type: "input", content: "Reply in this chat" }, context);
		const settled = await submission.wait(context);
		if (await telegramReplyNeeded(harness, { request: submission.id }, settled, context)) await telegram.send(7, "Here is the answer again");
		assert.equal(calls.filter((call) => !call.failed).length - before, 1, `${method ?? "ordinary reply"} should produce exactly one visible reply`);
	}
});
