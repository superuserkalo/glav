import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { skillsSection } from "./skills.ts";

/** The Linux sandbox operations used by the agent's tools. */
export type Computer = {
	workspace: string;
	/** A factual environment description, used in instructions. */
	description: string;
	exec(command: string, signal: AbortSignal): Promise<{ output: string; exitCode: number }>;
	read(path: string, signal?: AbortSignal): Promise<string>;
	write(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<void>;
};

export const DEFAULT_PROMPT = "You are Glav, an assistant chatting with users over Telegram. Keep replies short. Format with Markdown; Telegram renders it, tables and code blocks included.";

export function computerPrompt(computer: Pick<Computer, "workspace" | "description">): string {
	return `You run in ${computer.description}. Use your tools to run shell commands and read, write, and edit files when needed. When asked to do something, do it with your tools instead of explaining how. Your working directory is ${computer.workspace}, and files there are kept between conversations. Files the user sends are saved under ${computer.workspace}/inbox.`;
}

const MAX_OUTPUT = 30_000;
const clip = (text: string) => text.length > MAX_OUTPUT ? `[${text.length - MAX_OUTPUT} characters cut]\n${text.slice(-MAX_OUTPUT)}` : text;
const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
export const computerPath = (computer: Pick<Computer, "workspace">, path: string) => path.startsWith("/") ? path : `${computer.workspace}/${path}`;

/** Agent tools for the chat's Linux sandbox. */
export function computerTools(computer: Computer) {
	return defineExtension({ name: "computer", sections: [skillsSection(computer)], tools: [
		defineTool({
			name: "bash",
			description: `Run a shell command on your computer and get its output and exit code. Starts in ${computer.workspace}; each call is a fresh shell.`,
			parameters: Type.Object({ command: Type.String({ description: "The command, as you would type it in bash" }), timeout_seconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: 600, description: "Stop the command after this long. Default 120." })) }),
			replay: "unsafe",
			execute: async (args, _api, context) => {
				const seconds = args.timeout_seconds ?? 120;
				if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error("timeout_seconds must be greater than 0 and at most 600.");
				const timeout = AbortSignal.timeout(Math.ceil(seconds * 1000));
				const signal = context.abortSignal ? AbortSignal.any([timeout, context.abortSignal]) : timeout;
				const output = await computer.exec(args.command, signal);
				return result(`exit code ${output.exitCode}\n${clip(output.output)}`, output.exitCode !== 0);
			},
		}),
		defineTool({
			name: "read_file", description: `Read a text file from your computer. Relative paths are under ${computer.workspace}.`,
			parameters: Type.Object({ path: Type.String() }), replay: "safe",
			execute: async (args, _api, context) => result(clip(await computer.read(computerPath(computer, args.path), context.abortSignal))),
		}),
		defineTool({
			name: "write_file", description: `Write a text file on your computer, replacing it if it exists. Relative paths are under ${computer.workspace}.`,
			parameters: Type.Object({ path: Type.String(), content: Type.String() }), replay: "safe",
			execute: async (args, _api, context) => {
				const path = computerPath(computer, args.path);
				await computer.write(path, args.content, context.abortSignal);
				return result(`Wrote ${path}.`);
			},
		}),
	] });
}
