import { Type } from "@earendil-works/pi-ai";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";

/** One entry of `mcpServers`, in the format other MCP clients use. A `command` starts a local server; a `url` is a remote one. */
export type McpServerConfig = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	/** False keeps the entry without connecting to it. */
	enabled?: boolean;
	/** Seconds one request may take. Default 60. */
	timeout?: number;
};

export type McpConnections = {
	/** The servers' tools, to install in the registry. Absent when no server offered any. */
	extension?: Extension;
	/** One line per configured server: its tools, or why it is not connected. */
	describe(): string;
	close(): Promise<void>;
};

type Server = {
	name: string;
	config: McpServerConfig;
	client?: McpClient;
	tools: string[];
	error?: string;
};

/** Replace `${NAME}` by the environment variable, so the file can stay free of secrets. */
function expand<T>(value: T): T {
	if (typeof value === "string") return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "") as T;
	if (Array.isArray(value)) return value.map(expand) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) as T;
	return value;
}

/** Providers allow at most 64 characters of letters, digits, `_` and `-` in a tool name. */
function toolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

async function connect(server: Server, baseEnv: NodeJS.ProcessEnv): Promise<McpClient> {
	const config = expand(server.config);
	const client = new McpClient({ name: "glav", version: "0.1.0", requestTimeoutMs: (config.timeout ?? 60) * 1000 });
	const transport = config.url
		? new StreamableHttpTransport({ url: config.url, headers: config.headers })
		: new StdioTransport({
				command: config.command ?? "",
				args: config.args,
				// A server gets the base environment and what its entry names, not everything this process holds.
				env: { ...(baseEnv as Record<string, string>), ...config.env },
				cwd: config.cwd,
				inheritEnv: false,
			});
	// A server that goes away is connected again by the next call that needs it.
	client.onClose(() => {
		if (server.client === client) server.client = undefined;
	});
	client.onError(() => undefined);
	await client.connect(transport);
	server.client = client;
	return client;
}

/**
 * Connect to every enabled server and wrap its tools. A server that fails is reported and left out; the rest still work.
 * Local servers are started with `baseEnv`, which should not hold this process's secrets; an entry that needs one names
 * it in its `env` as `${NAME}`.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>, baseEnv: NodeJS.ProcessEnv = process.env): Promise<McpConnections> {
	const connected: Server[] = Object.entries(servers).map(([name, config]) => ({ name, config, tools: [] }));
	const tools: ToolRegistration[] = [];

	await Promise.all(
		connected.map(async (server) => {
			if (server.config.enabled === false) {
				server.error = "disabled";
				return;
			}
			if (!server.config.command && !server.config.url) {
				server.error = "needs a command or a url";
				return;
			}
			try {
				const client = await connect(server, baseEnv);
				for (const tool of await client.listTools()) {
					const name = toolName(server.name, tool.name);
					server.tools.push(tool.name);
					tools.push(
						defineTool({
							name,
							description: `[${server.name}] ${tool.description ?? tool.title ?? tool.name}`,
							// Providers require an object schema, and some reject one without `properties`.
							parameters: Type.Unsafe<Record<string, unknown>>({
								...tool.inputSchema,
								type: "object",
								properties: tool.inputSchema.properties ?? {},
							}),
							// Only a tool its server calls read-only may run again after a crash interrupted it.
							replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
							execute: async (args, _api, context) => {
								const result = await (server.client ?? (await connect(server, baseEnv))).callTool(tool.name, args, {
									signal: context.abortSignal,
								});
								// MCP reports a tool's failure in the result instead of as a protocol error.
								return { content: toLlmContent(result), isError: result.isError === true };
							},
						}) as ToolRegistration,
					);
				}
			} catch (error) {
				server.error = error instanceof Error ? error.message : String(error);
				console.error(`MCP server ${server.name} is not available: ${server.error}`);
			}
		}),
	);

	return {
		extension: tools.length > 0 ? defineExtension({ name: "mcp", tools }) : undefined,
		describe: () =>
			connected.length === 0
				? "No MCP servers are configured."
				: connected
						.map((server) =>
							server.error
								? `**${server.name}**: not connected (${server.error})`
								: `**${server.name}**: ${server.tools.length} tools${server.tools.length > 0 ? ` (${server.tools.join(", ")})` : ""}`,
						)
						.join("\n"),
		close: async () => {
			await Promise.allSettled(connected.map((server) => server.client?.close()));
		},
	};
}
