import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { startAgent } from "./agent.ts";
import { connectMcp, type McpServerConfig } from "./mcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// What the model's shell and the MCP servers are started with: this process's environment without what .env holds
// (the bot token, API keys, the shared secret), so a command or a third-party server does not get them for free.
const toolEnv = { ...process.env };
for (const name of existsSync(envFile) ? Object.keys(parseEnv(readFileSync(envFile, "utf8"))) : []) delete toolEnv[name];

const agentAddr = process.env.agent_addr ?? "127.0.0.1:8787";
const [host, port] = agentAddr.split(":");
const provider = process.env.model_provider ?? "openai";
const modelId = process.env.model_id ?? "gpt-6-luna";
const dataFile = resolve(here, "..", process.env.agent_data ?? "data/glav.sqlite");
const workspace = resolve(here, "..", (process.env.workspace ?? "data/workspace").replace(/^~(?=\/|$)/, homedir()));
await mkdir(workspace, { recursive: true });
const secret = process.env.agent_secret;
if (!secret) throw new Error("agent_secret is not set in .env. Generate one with: openssl rand -hex 32");

/** Speech to text through OpenAI, which takes Telegram's OGG voice notes as they are. */
async function transcribe(path: string, mime: string | undefined): Promise<string> {
	const form = new FormData();
	form.set("model", process.env.transcribe_model ?? "gpt-transcribe");
	form.set("file", new Blob([await readFile(path)], { type: mime ?? "audio/ogg" }), basename(path));
	const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
		body: form,
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`transcription failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
	return ((await response.json()) as { text: string }).text;
}

const mcpFile = resolve(here, "..", process.env.mcp_config ?? "mcp.json");
const mcp = await connectMcp(
	existsSync(mcpFile) ? ((JSON.parse(await readFile(mcpFile, "utf8")) as { mcpServers?: Record<string, McpServerConfig> }).mcpServers ?? {}) : {},
	toolEnv,
);

const agent = await startAgent({
	storage: await openNodeSqliteStorage(dataFile),
	models: builtinModels(),
	provider,
	modelId,
	instructions:
		process.env.system_prompt ??
		[
			"You are Glav, an assistant chatting with users over Telegram.",
			`You run in a Linux system with internet access. Use your tools to run shell commands and read, write, and edit files when needed. When asked to do something, do it with your tools instead of explaining how. Your working directory is ${workspace}.`,
			"Files the user sends are saved under the inbox folder of your working directory, and you are told their paths.",
			"Keep replies short. Format with Markdown; Telegram renders it, tables and code blocks included.",
		].join("\n"),
	transportUrl: `http://${process.env.send_addr ?? "127.0.0.1:8788"}`,
	secret,
	host: host!,
	port: Number(port),
	workspace,
	transcribe: process.env.OPENAI_API_KEY ? transcribe : undefined,
	toolEnv,
	extensions: mcp.extension ? [mcp.extension] : [],
	describeMcp: mcp.describe,
});
console.log(mcp.describe().replaceAll("**", ""));
console.log(`glav agent on http://${agentAddr}, model ${provider}/${modelId}, workspace ${workspace}, storage ${dataFile}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void Promise.allSettled([agent.close(), mcp.close()]).finally(() => process.exit(0)));
}
