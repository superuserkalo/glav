export const SNAPSHOT_KEY = "computer-snapshot";
const RETENTION_KEY = "computer-snapshot-retention";
const WORK_ALARM_KEY = "computer-work-alarm";
const DAY = 24 * 60 * 60_000;
const RENEW_AFTER = 21 * DAY;
const TTL = 30 * DAY;
const RETRY_AFTER = 60 * 60_000;

type Retention = {
	snapshot: string;
	retainedAt?: number;
	expiresAt?: number;
	nextAttemptAt: number;
	failures: number;
	lastError?: string;
};
type WorkAlarm = { at: number; id: string };
type Storage = Pick<DurableObjectStorage, "get" | "transaction">;
type Computer = Pick<Container, "running" | "start" | "setInactivityTimeout" | "exec" | "destroy">;

/** Renew Cloudflare's 30-day snapshot lease without opening a conversation or running the image's startup commands. */
export class SnapshotRenewal {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly storage: Storage;
	private readonly container?: Computer;
	private readonly now: () => number;
	constructor(storage: Storage, container?: Computer, now: () => number = Date.now) {
		this.storage = storage;
		this.container = container;
		this.now = now;
	}

	/** A maintenance restore must finish and stop before a user can acquire the computer. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work, work);
		this.tail = next.catch(() => undefined);
		return next;
	}

	async initialize(): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const snapshot = await tx.get<string>(SNAPSHOT_KEY);
			const retained = await tx.get<Retention>(RETENTION_KEY);
			// Older deployments only stored the snapshot ID. Preserve their watchdog alarm, and renew now because its age is unknown.
			if (!retained) {
				const alarm = await tx.getAlarm();
				if (alarm !== null && await tx.get(WORK_ALARM_KEY) === undefined) await tx.put<WorkAlarm>(WORK_ALARM_KEY, { at: alarm, id: crypto.randomUUID() });
			}
			if (snapshot && retained?.snapshot !== snapshot) await tx.put<Retention>(RETENTION_KEY, { snapshot, nextAttemptAt: this.now(), failures: 0 });
			await this.schedule(tx);
		});
	}

	/** Creation and successful restoration both start a new 30-day retention period. Call while holding exclusive(). */
	async retained(snapshot: string): Promise<void> {
		const now = this.now();
		await this.storage.transaction(async (tx) => {
			await tx.put(SNAPSHOT_KEY, snapshot);
			await tx.put<Retention>(RETENTION_KEY, { snapshot, retainedAt: now, expiresAt: now + TTL, nextAttemptAt: now + RENEW_AFTER, failures: 0 });
			await this.schedule(tx);
		});
	}

	async scheduleWork(at: number | null, completed?: string): Promise<string | undefined> {
		return this.storage.transaction(async (tx) => {
			const current = await tx.get<WorkAlarm>(WORK_ALARM_KEY);
			if (at === null) {
				// An inbound message may have scheduled new work while the watchdog was finishing its old session.
				if (completed === undefined || current?.id === completed) await tx.delete(WORK_ALARM_KEY);
			} else {
				const otherDeadline = current && current.id !== completed && current.at > this.now() ? current.at : Infinity;
				await tx.put<WorkAlarm>(WORK_ALARM_KEY, { at: Math.min(at, otherDeadline), id: crypto.randomUUID() });
			}
			await this.schedule(tx);
			return (await tx.get<WorkAlarm>(WORK_ALARM_KEY))?.id;
		});
	}

	async workDue(): Promise<boolean> {
		const alarm = await this.storage.get<WorkAlarm>(WORK_ALARM_KEY);
		return alarm !== undefined && alarm.at <= this.now();
	}

	async status(): Promise<Retention | null> {
		return await this.storage.get<Retention>(RETENTION_KEY) ?? null;
	}

	async renewIfDue(force = false): Promise<void> {
		await this.exclusive(async () => {
			const state = await this.status();
			if (!state || !force && state.nextAttemptAt > this.now()) return;
			// Persist the retry before starting, so eviction or an exhausted platform retry cannot abandon the lease.
			await this.defer();
			const container = this.container;
			if (container?.running) return; // Never stop or replace a user's running computer. A normal save will renew it.
			try {
				if (!container) throw new Error("This chat has no computer to renew its snapshot.");
				let started = false;
				try {
					container.start({ containerSnapshot: { id: state.snapshot }, instance: "lite", enableInternet: false, entrypoint: ["sleep", "infinity"] });
					started = true;
					await container.setInactivityTimeout(60_000);
					const process = await container.exec(["true"], { signal: AbortSignal.timeout(120_000) });
					const output = await process.output();
					if (output.exitCode !== 0) throw new Error(`Snapshot readiness check exited with ${output.exitCode}.`);
				} finally {
					if (started) await container.destroy();
				}
				await this.retained(state.snapshot);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown snapshot renewal failure";
				await this.defer(message);
				console.error(`renewing the computer snapshot failed: ${message}`);
			}
		});
	}

	private async defer(error?: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const state = await tx.get<Retention>(RETENTION_KEY);
			if (state) await tx.put<Retention>(RETENTION_KEY, { ...state, nextAttemptAt: this.now() + RETRY_AFTER, ...(error ? { failures: state.failures + 1, lastError: error } : {}) });
			await this.schedule(tx);
		});
	}

	/** One DO alarm serves both the conversation watchdog and snapshot renewal. Transactions preserve the earlier deadline. */
	private async schedule(tx: DurableObjectTransaction): Promise<void> {
		const work = await tx.get<WorkAlarm>(WORK_ALARM_KEY);
		const retention = await tx.get<Retention>(RETENTION_KEY);
		const next = Math.min(work?.at ?? Infinity, retention?.nextAttemptAt ?? Infinity);
		const alarm = await tx.getAlarm();
		if (Number.isFinite(next)) {
			// Do not reschedule a due alarm from its constructor, which runs before the alarm handler.
			if (alarm !== next && !(alarm !== null && alarm <= this.now() && next <= this.now())) await tx.setAlarm(next);
		} else if (alarm !== null) await tx.deleteAlarm();
	}
}
