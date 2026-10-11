import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { ConversationRuntime, type ConversationState } from "../src/runtime/conversation.ts";
import { computerPrompt, computerTools, type Computer } from "../src/runtime/computer.ts";
import { inputContent } from "../src/runtime/content.ts";

const State = defineDoc<ConversationState>({ kind: "test.delivery", version: 1, scope: "session", initial: () => ({ pending: {}, delivered: [], answers: [] }) });
async function until(done: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!done()) { if (Date.now() > deadline) throw new Error("runtime did not settle"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("reopening the controller delivers a persisted answer and skips attachment work for a duplicate", async (t) => {
	const storage = new MemoryStorage();
	const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
	const model: ModelRef = { provider: "faux", modelId: faux.getModel().id };
	const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { steeringMode: "all" } }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	const sent: string[] = [];
	let failed = false;
	function controller(send: (text: string) => Promise<void>) {
		return new ConversationRuntime({ harness, conversation, models, defaultModel: model,
			state: { read: () => harness.snapshot(State, context), update: async (change) => { await harness.commit(async (tx) => change(await tx.doc(State)), context); } },
			configure: (state) => ({ model: state?.model ?? model, instructions: "test" }), transport: { send, draft: async () => {} },
		});
	}
	let runtime = controller(async () => { failed = true; throw new Error("transport offline"); });
	await runtime.start(); harness.resume();
	faux.appendResponses([fauxAssistantMessage("durable answer")]);
	await runtime.admit("42", async () => "hello");
	await until(() => failed);
	await runtime.close();
	const calls = faux.state.callCount;
	runtime = controller(async (text) => { sent.push(text); });
	t.after(() => runtime.close());
	await runtime.start(); await runtime.recover();
	await until(() => sent.length === 1);
	await runtime.admit("42", async () => { throw new Error("duplicate must not download or transcribe files"); });
	assert.deepEqual(sent, ["durable answer"]);
	assert.equal(faux.state.callCount, calls);
});

test("computer tools resolve workspace paths and report unsuccessful commands", async (t) => {
	const files = new Map<string, string | Uint8Array>();
	const computer: Computer = { workspace: "/workspace", description: "a cloud Linux sandbox",
		exec: async () => ({ output: "failure", exitCode: 7 }),
		read: async (path) => String(files.get(path)), write: async (path, content) => { files.set(path, content); },
	};
	const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(computerTools(computer));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	await conversation.configure({ model: { provider: "faux", modelId: faux.getModel().id }, instructions: computerPrompt(computer) }, context);
	harness.resume();
	let results: unknown;
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("write_file", { path: "nested/hello.txt", content: "same tools" }), { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_file", { path: "nested/hello.txt" }), fauxToolCall("bash", { command: "printf failure; exit 7" })], { stopReason: "toolUse" }),
		(transcript) => { results = transcript.messages.filter((message) => message.role === "toolResult"); return fauxAssistantMessage("done"); },
	]);
	const submission = await conversation.submit({ type: "input", content: "Write, read, then run a failing command" }, context);
	assert.equal((await submission.wait(context)).status, "done");
	assert.equal(files.get("/workspace/nested/hello.txt"), "same tools");
	assert.match(JSON.stringify(results), /same tools/);
	assert.match(JSON.stringify(results), /exit code 7/);
	assert.match(JSON.stringify(results), /"isError":true/);
	assert.match(computerPrompt(computer), /Linux sandbox/);
});

test("command deadlines reach the execution adapter and bash is unsafe to replay", async () => {
	let aborted = false;
	const computer: Computer = { workspace: "/workspace", description: "a Linux sandbox",
		exec: async (_command, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve({ output: "stopped", exitCode: 137 }); }, { once: true }); }),
		read: async () => "", write: async () => {},
	};
	const tools = computerTools(computer).tools!;
	const bash: ToolRegistration = tools.find((tool) => tool.name === "bash")!;
	assert.equal(bash.replay, "unsafe");
	await bash.execute({ command: "sleep forever", timeout_seconds: 0.01 }, {} as never, context);
	assert.equal(aborted, true);
});

test("attachment context names the saved sandbox file, and transient download errors remain retryable", async () => {
	const file = { kind: "document" as const, name: "report.pdf", mime: "application/pdf", size: 8 };
	const content = await inputContent({ attachments: [file] }, { seesImages: false, read: async () => new Uint8Array(), save: async () => "/workspace/inbox/report.pdf" });
	assert.match(content as string, /report\.pdf, application\/pdf, 8 bytes, saved at \/workspace\/inbox\/report\.pdf/);
	await assert.rejects(inputContent({ attachments: [{ ...file, mime: "image/png" }] }, { seesImages: true, read: async () => { throw new Error("network down"); }, permanent: () => false }), /network down/);
});
