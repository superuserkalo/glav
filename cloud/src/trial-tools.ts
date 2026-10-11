import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { Access, accessPrompt } from "./access.ts";

export type TrialChat = { chatId: number; code?: string; updateId?: number; firstName?: string; introduction?: boolean };

/** Identity, free-turn receipt, and candidate code come from authenticated Telegram input. */
export function trialTools(access: Access, current: () => Promise<TrialChat>) {
	const activate = defineTool({
		name: "activate_trial",
		description: "Redeem the code supplied by this user. Its campaign determines the trial duration; returns the actual backend expiry. Cannot grant access to another account.",
		parameters: Type.Object({ code: Type.String() }), replay: "safe",
		execute: async ({ code }) => {
			const chat = await current(), normalized = code.trim().toUpperCase();
			const result = chat.code === normalized ? await access.redeem(chat.chatId, normalized) : { status: "invalid" };
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: result.status !== "active" };
		},
	});
	const status = defineTool({
		name: "access_status", description: "Read this account's actual free allowance, trial, subscription, and beta offer. Cannot modify access or inspect another account.",
		parameters: Type.Object({}), replay: "safe",
		execute: async () => ({ content: [{ type: "text" as const, text: accessPrompt(await access.state((await current()).chatId)) }] }),
	});
	const extension = defineExtension({
		name: "access", tools: access.deploymentMode === "self-hosted" ? [status] : [activate, status],
		sections: [section("access", async () => { const chat = await current(); return accessPrompt(await access.state(chat.chatId), chat.firstName, chat.introduction); })],
		hooks: [
			hook(GenerationTask, { beforeRequest: async () => {
				const chat = await current();
				if ((await access.state(chat.chatId)).agent) return;
				if (chat.updateId !== undefined && await access.freeTurn(chat.chatId, chat.updateId)) return;
				if (chat.code && await access.canRedeem(chat.chatId, chat.code)) return;
				throw new Error("Free messages are exhausted and agent access is inactive or expired.");
			} }),
			hook(ToolTask, { beforeTool: async (call) => {
				if (call.name === activate.name || call.name === status.name) return;
				if (!(await access.state((await current()).chatId)).agent) return { block: "Full agent tools require an active trial or subscription. Access is inactive or expired." };
			} }),
		],
	});
	return { activate, status, extension };
}
