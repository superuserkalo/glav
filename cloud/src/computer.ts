import type { Files } from "@cloudflare/sandbox";
import type { Computer } from "./runtime/computer.ts";
import { SNAPSHOT_KEY, type SnapshotRenewal } from "./snapshot-renewal.ts";

const IDLE_MS = 5 * 60_000;
const SESSION_KEY = "computer-session";
const START_KEY = "computer-last-start";
type Session = { startedAt: number; lastUsedAt: number; countedMs: number };

/** Cloud container lifecycle and files. No model, conversation or tool definitions live here. */
export class SandboxComputer implements Computer {
	readonly workspace = "/workspace";
	readonly description = "a cloud Linux sandbox with internet access";
	private readonly ctx: DurableObjectState;
	private readonly count: (computerMs: number) => Promise<void>;
	private readonly snapshots: SnapshotRenewal;
	private used = false;

	constructor(ctx: DurableObjectState, count: (computerMs: number) => Promise<void>, snapshots: SnapshotRenewal) {
		this.ctx = ctx;
		this.count = count;
		this.snapshots = snapshots;
		if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(IDLE_MS));
	}

	private async computer(): Promise<Container> {
		return this.snapshots.exclusive(async () => {
			const container = this.ctx.container;
			if (!container) throw new Error("This chat has no computer.");
			if (!container.running) {
				const snapshot = await this.ctx.storage.get<string>(SNAPSHOT_KEY);
				const options = { instance: "lite" as const, enableInternet: true };
				const began = Date.now();
				if (snapshot) container.start({ containerSnapshot: { id: snapshot }, ...options });
				else container.start({ image: container.images.sandbox!, ...options });
				await container.setInactivityTimeout(IDLE_MS);
				await (await container.exec(["true"])).output();
				if (snapshot) await this.snapshots.retained(snapshot);
				await this.ctx.storage.put(START_KEY, { ms: Date.now() - began, from: snapshot ? "snapshot" : "image", at: new Date(began).toISOString() });
				await this.settle(false);
				await this.ctx.storage.put<Session>(SESSION_KEY, { startedAt: began, lastUsedAt: began, countedMs: 0 });
			}
			this.used = true;
			await this.touch();
			return container;
		});
	}

	private async files(): Promise<Files> {
		const { Files } = await import("@cloudflare/sandbox");
		return new Files(await this.computer());
	}

	private async touch(): Promise<void> {
		const session = await this.ctx.storage.get<Session>(SESSION_KEY);
		if (session) await this.ctx.storage.put<Session>(SESSION_KEY, { ...session, lastUsedAt: Date.now() });
	}

	async exec(command: string, signal: AbortSignal): Promise<{ output: string; exitCode: number }> {
		signal.throwIfAborted();
		const container = await this.computer();
		signal.throwIfAborted();
		const process = await container.exec(["/bin/bash", "-lc", command], { cwd: this.workspace, stderr: "combined" });
		// Cancel the remote process itself, including when cancellation arrived during launch.
		const kill = () => process.kill(9);
		signal.addEventListener("abort", kill, { once: true });
		if (signal.aborted) kill();
		try {
			const output = await process.output();
			signal.throwIfAborted();
			return { output: new TextDecoder().decode(output.stdout), exitCode: output.exitCode };
		} finally { signal.removeEventListener("abort", kill); await this.touch(); }
	}

	async read(path: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		return (await (await this.files()).readFile(path, { signal })).text();
	}

	async write(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const files = await this.files();
		await files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true, signal });
		await files.writeFile(path, content, { signal });
	}

	async saveIfUsed(): Promise<void> {
		await this.snapshots.exclusive(async () => {
			if (!this.used || !this.ctx.container?.running) return;
			this.used = false;
			try { await this.snapshots.retained((await this.ctx.container.snapshotContainer({})).id); }
			catch (error) { this.used = true; console.error(`saving the computer failed: ${error instanceof Error ? error.message : "unknown error"}`); }
		});
	}

	/** Account for the last stretch even when the container stopped while the object was evicted. */
	async settle(running = this.ctx.container?.running ?? false): Promise<void> {
		const session = await this.ctx.storage.get<Session>(SESSION_KEY);
		if (!session) return;
		const end = running ? Date.now() : Math.min(Date.now(), session.lastUsedAt + IDLE_MS);
		const lasted = Math.max(end - session.startedAt, 0);
		await this.count(Math.max(lasted - session.countedMs, 0));
		if (running) await this.ctx.storage.put<Session>(SESSION_KEY, { ...session, countedMs: lasted });
		else await this.ctx.storage.delete(SESSION_KEY);
	}

	async reportAt(): Promise<number | undefined> {
		return this.snapshots.exclusive(async () => {
			const session = await this.ctx.storage.get<Session>(SESSION_KEY);
			if (!session) return;
			const stopsAt = session.lastUsedAt + IDLE_MS;
			if (Date.now() < stopsAt) return stopsAt;
			// Polling also counts as container activity and would otherwise postpone its shutdown forever.
			if (!this.used && this.ctx.container?.running) await this.ctx.container.destroy();
			return this.ctx.container?.running ? Date.now() + 60_000 : 0;
		});
	}

	async status() {
		return { attached: true, running: this.ctx.container?.running, snapshot: await this.ctx.storage.get<string>(SNAPSHOT_KEY), lastStart: await this.ctx.storage.get(START_KEY) };
	}
}
