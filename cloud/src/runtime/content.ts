import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type Attachment = {
	kind: "photo" | "voice" | "audio" | "document" | "video";
	name: string;
	mime?: string;
	size?: number;
};

export type InputContent = string | (TextContent | ImageContent)[];

/** Resolves Telegram attachments into the model's text and image context. */
export async function inputContent<T extends Attachment>(input: { text?: string; notes?: string[]; attachments?: T[] }, io: {
	seesImages: boolean;
	read(file: T): Promise<Uint8Array>;
	save?: (file: T) => Promise<string>;
	transcribe?: (file: T) => Promise<string>;
	/** Only permanent download failures become notes; transient failures must be retried by the host. */
	permanent?: (error: unknown) => boolean;
}): Promise<InputContent> {
	const notes = [...input.notes ?? []];
	const images: ImageContent[] = [];
	for (const file of input.attachments ?? []) {
		try {
			if ((file.kind === "voice" || file.kind === "audio") && io.transcribe) {
				notes.push(`[${file.kind === "voice" ? "Voice message" : `Audio file ${file.name}`}, transcribed] ${(await io.transcribe(file)).trim()}`);
				continue;
			}
			if (file.mime?.startsWith("image/") && io.seesImages) {
				const bytes = await io.read(file);
				images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: file.mime });
				notes.push(`[Image ${file.name}]`);
				continue;
			}
			const path = await io.save?.(file);
			notes.push(`[The user sent a ${file.kind}: ${file.name}, ${file.mime ?? "unknown type"}, ${file.size ?? "?"} bytes${path ? `, saved at ${path}` : ". You have nowhere to open it."}]`);
		} catch (error) {
			if (!io.permanent?.(error)) throw error;
			notes.push(`[The user sent a ${file.kind} (${file.name}) that could not be received: ${error instanceof Error ? error.message : String(error)}]`);
		}
	}
	const text = [input.text, ...notes].filter(Boolean).join("\n\n");
	return images.length ? [{ type: "text", text }, ...images] : text;
}
