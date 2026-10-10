// A minimal MCP server over stdio for the tests: newline-delimited JSON-RPC with two tools.
import { createInterface } from "node:readline";

const tools = [
	{
		name: "add",
		description: "Add two numbers",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
		annotations: { readOnlyHint: true },
	},
	{ name: "fail", description: "Always fails", inputSchema: { type: "object" } },
];

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) continue;
	if (method === "initialize") {
		respond(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
	} else if (method === "tools/list") {
		respond(id, { tools });
	} else if (method === "tools/call" && params.name === "add") {
		respond(id, { content: [{ type: "text", text: `${process.env.PREFIX ?? ""}${params.arguments.a + params.arguments.b}` }] });
	} else if (method === "tools/call") {
		respond(id, { content: [{ type: "text", text: "it broke" }], isError: true });
	} else {
		respond(id, {});
	}
}
