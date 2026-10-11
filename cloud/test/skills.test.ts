import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { computerTools, type Computer } from "../src/runtime/computer.ts";
import { discoverSkills, skillsDirectory } from "../src/runtime/skills.ts";

const run = promisify(execFile);
async function fixture(t: TestContext) {
	// An apostrophe checks the shell quoting used when scanning a selected workspace.
	const workspace = await mkdtemp(join(tmpdir(), "glav-skills-'"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const commands: string[] = [], reads: string[] = [];
	const computer: Computer = {
		workspace, description: "a test Linux sandbox",
		async exec(command, signal) {
			commands.push(command);
			const result = await run("/bin/bash", ["-lc", command], { cwd: workspace, signal, maxBuffer: 4 * 1024 * 1024 });
			return { output: result.stdout, exitCode: 0 };
		},
		async read(path, signal) { reads.push(path); return readFile(path, { encoding: "utf8", signal }); },
		async write(path, content, signal) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { signal }); },
	};
	async function file(path: string, text: string) { const full = join(skillsDirectory(computer), path); await computer.write(full, text); return full; }
	return { computer, commands, reads, file };
}

test("discovery creates the directory and reads nested skill headers with standard YAML", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await discoverSkills(f.computer, new AbortController().signal), { skills: [], diagnostics: [] });
	await access(skillsDirectory(f.computer));
	const path = await f.file("reports/weekly/SKILL.md", '\ufeff---\r\nname: weekly-report\r\ndescription: >-\r\n  Prepare a report:\r\n  use the project files.\r\n---\r\nPRIVATE BODY\r\n');
	await f.file("quoted/SKILL.md", '---\ndescription: "Use #notes: carefully & accurately"\n---\nInstructions.');
	await f.file("separators/SKILL.md", "---\ndescription: |-\n  Keep these separators:\n  ---\n  ...\n---\nInstructions.");
	const found = await discoverSkills(f.computer, new AbortController().signal);
	assert.deepEqual(found.skills.map((skill) => [skill.name, skill.description]), [["quoted", "Use #notes: carefully & accurately"], ["weekly-report", "Prepare a report: use the project files."], ["separators", "Keep these separators:\n---\n..."]]);
	assert.equal(found.skills[1]!.path, path);
	assert.deepEqual(found.diagnostics, []);
	assert.deepEqual(f.reads, [], "the model has not read any full skill instructions");
});

test("discovery skips supporting folders and diagnoses malformed, duplicate, and oversized skills", async (t) => {
	const f = await fixture(t);
	await f.file("a/SKILL.md", "---\nname: report\ndescription: Valid\n---\nInstructions.");
	await f.file("a/references/nested/SKILL.md", "---\nname: supporting\ndescription: Must not discover\n---\n");
	await f.file("b/SKILL.md", "---\nname: report\ndescription: Duplicate\n---\n");
	await f.file("bad-yaml/SKILL.md", "---\ndescription: [unterminated\n---\n");
	await f.file("missing/SKILL.md", "No frontmatter");
	await f.file("no-description/SKILL.md", "---\nname: no-description\n---\n");
	await f.file("oversized/SKILL.md", `---\ndescription: ${"x".repeat(17_000)}\n---\n`);
	await f.file(".hidden/SKILL.md", "---\ndescription: Hidden\n---\n");
	await f.file("node_modules/dep/SKILL.md", "---\ndescription: Dependency\n---\n");
	await symlink(join(skillsDirectory(f.computer), "a"), join(skillsDirectory(f.computer), "cycle"));
	const found = await discoverSkills(f.computer, new AbortController().signal);
	assert.deepEqual(found.skills.map((skill) => skill.name), ["report"]);
	assert.equal(found.diagnostics.length, 5);
	assert.match(JSON.stringify(found.diagnostics), /Duplicate skill name/);
	assert.match(JSON.stringify(found.diagnostics), /16 KiB/);
});

test("the durable agent sees metadata, reads a matching skill, runs its script, and refreshes changes", async (t) => {
	const f = await fixture(t);
	const path = await f.file("report/SKILL.md", "---\nname: report\ndescription: Prepare <weekly> & project reports\n---\nPRIVATE INSTRUCTIONS: Run scripts/report.sh from this skill directory.");
	const script = await f.file("report/scripts/report.sh", "printf 'report complete'");
	await f.file("manual/SKILL.md", "---\nname: manual\ndescription: EXPLICIT ONLY\ndisable-model-invocation: true\n---\nManual instructions.");
	const storagePath = join(f.computer.workspace, "conversation.sqlite");
	const registry = createRegistry(); registry.install(computerTools(f.computer));
	const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
	let harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	t.after(() => harness.close(context));
	let conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: faux.getModel().id } } });
	harness.resume();
	const prompts: string[] = [];
	let readResult = "", scriptResult = "";
	faux.appendResponses([
		(transcript) => { prompts.push(getCurrentSystemPrompt(transcript.messages)); return fauxAssistantMessage(fauxToolCall("read_file", { path }), { stopReason: "toolUse" }); },
		(transcript) => { readResult = JSON.stringify(transcript.messages.findLast((message) => message.role === "toolResult")); return fauxAssistantMessage(fauxToolCall("bash", { command: `bash '${script.replaceAll("'", "'\\''")}'` }), { stopReason: "toolUse" }); },
		(transcript) => { scriptResult = JSON.stringify(transcript.messages.findLast((message) => message.role === "toolResult")); return fauxAssistantMessage("done"); },
	]);
	assert.equal((await (await conversation.submit({ type: "input", content: "Prepare a weekly report" }, context)).wait(context)).status, "done");
	assert.match(prompts[0]!, /Prepare &lt;weekly&gt; &amp; project reports/);
	assert.ok(prompts[0]!.includes(path.replaceAll("'", "&apos;")));
	assert.doesNotMatch(prompts[0]!, /PRIVATE INSTRUCTIONS|EXPLICIT ONLY/);
	assert.match(readResult, /PRIVATE INSTRUCTIONS/);
	assert.match(scriptResult, /report complete/);
	assert.deepEqual(f.reads, [path]);

	await f.computer.write(path, "---\nname: report\ndescription: UPDATED DESCRIPTION\n---\nUpdated instructions.");
	faux.appendResponses([(transcript) => { prompts.push(getCurrentSystemPrompt(transcript.messages)); return fauxAssistantMessage("updated"); }]);
	assert.equal((await (await conversation.submit({ type: "input", content: "Again" }, context)).wait(context)).status, "done");
	assert.match(prompts.at(-1)!, /UPDATED DESCRIPTION/);
	assert.doesNotMatch(prompts.at(-1)!, /Prepare &lt;weekly&gt;/);

	await harness.close(context);
	harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	conversation = await harness.root(context);
	await conversation.reset(undefined, context);
	faux.appendResponses([(transcript) => { prompts.push(getCurrentSystemPrompt(transcript.messages)); return fauxAssistantMessage("reopened"); }]);
	assert.equal((await (await conversation.submit({ type: "input", content: "New conversation" }, context)).wait(context)).status, "done");
	assert.match(prompts.at(-1)!, /UPDATED DESCRIPTION/, "sandbox files remain discoverable after reopen and reset");

	await rm(dirname(path), { recursive: true });
	faux.appendResponses([(transcript) => { prompts.push(getCurrentSystemPrompt(transcript.messages)); return fauxAssistantMessage("removed"); }]);
	assert.equal((await (await conversation.submit({ type: "input", content: "Again" }, context)).wait(context)).status, "done");
	assert.doesNotMatch(prompts.at(-1)!, /UPDATED DESCRIPTION/);
});

test("a conversation without computer access never scans or advertises skills", async (t) => {
	const f = await fixture(t);
	const registry = createRegistry(); registry.install(computerTools(f.computer));
	const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: faux.getModel().id }, tools: [] } });
	let prompt = "";
	faux.appendResponses([(transcript) => { prompt = getCurrentSystemPrompt(transcript.messages); return fauxAssistantMessage("hello"); }]);
	assert.equal((await (await conversation.submit({ type: "input", content: "hello" }, context)).wait(context)).status, "done");
	assert.deepEqual(f.commands, []);
	assert.doesNotMatch(prompt, /available_skills|\.agents\/skills/);
});
