import assert from "node:assert/strict";
import { test } from "node:test";
import { SNAPSHOT_KEY, SnapshotRenewal } from "../src/snapshot-renewal.ts";

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

/** A persisted DO store and expiring snapshot service, with time advanced without real waits. */
function fixture() {
	let now = Date.UTC(2026, 9, 11);
	let alarm = null;
	let transaction = Promise.resolve();
	const values = new Map();
	const snapshots = new Map([["original", { expires: now + 30 * DAY, files: { "/workspace/memory/life.md": "Keep the apartment handover documents." } }]]);
	const events = [];
	const tx = {
		get: async (key) => structuredClone(values.get(key)),
		put: async (key, value) => { values.set(key, structuredClone(value)); },
		delete: async (key) => values.delete(key),
		getAlarm: async () => alarm,
		setAlarm: async (at) => { alarm = at; },
		deleteAlarm: async () => { alarm = null; },
	};
	const storage = {
		...tx,
		transaction(work) {
			const next = transaction.then(async () => {
				const before = structuredClone(values);
				const alarmBefore = alarm;
				try { return await work(tx); }
				catch (error) { values.clear(); for (const [key, value] of before) values.set(key, value); alarm = alarmBefore; throw error; }
			});
			transaction = next.catch(() => undefined);
			return next;
		},
	};
	const container = {
		running: false,
		startError: null,
		exitCode: 0,
		probe: null,
		files: null,
		start(options) {
			events.push({ action: "start", options });
			if (this.startError) throw this.startError;
			assert.equal(this.running, false, "never start over a running computer");
			const snapshot = snapshots.get(options.containerSnapshot.id);
			if (!snapshot || snapshot.expires <= now) throw new Error("Snapshot expired");
			snapshot.expires = now + 30 * DAY;
			this.files = structuredClone(snapshot.files);
			this.running = true;
		},
		async setInactivityTimeout(ms) { events.push({ action: "timeout", ms }); },
		async exec(command, options) {
			events.push({ action: "exec", command });
			assert.deepEqual(command, ["true"]);
			assert.ok(options.signal instanceof AbortSignal);
			return { output: async () => { if (this.probe) await this.probe(); return { exitCode: this.exitCode }; } };
		},
		async destroy() { events.push({ action: "stop" }); this.running = false; },
	};
	return {
		storage, container, events, snapshots,
		controller: () => new SnapshotRenewal(storage, container, () => now),
		now: () => now,
		advance: (ms) => { now += ms; },
		alarm: () => alarm,
		fire: () => { alarm = null; },
	};
}

test("a saved snapshot is renewed across months of inactivity and DO restarts", async () => {
	const f = fixture();
	await f.controller().retained("original");
	for (let month = 0; month < 9; month++) {
		f.advance(21 * DAY);
		const renewal = f.controller();
		await renewal.initialize();
		assert.equal(await renewal.workDue(), false, "renewal must not become conversation work after restart");
		f.fire();
		await renewal.renewIfDue();
		assert.equal(f.container.files["/workspace/memory/life.md"], "Keep the apartment handover documents.");
		assert.equal(f.container.running, false);
		assert.equal((await renewal.status()).expiresAt, f.now() + 30 * DAY);
		assert.equal(f.alarm(), f.now() + 21 * DAY);
	}
	assert.equal(f.events.filter((e) => e.action === "start").length, 9);
	for (const event of f.events.filter((e) => e.action === "start")) {
		assert.equal(event.options.enableInternet, false);
		assert.deepEqual(event.options.entrypoint, ["sleep", "infinity"]);
		assert.deepEqual(event.options.containerSnapshot, { id: "original" });
	}
});

test("normal saves and restores reset the deadline and avoid early renewal", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.retained("original");
	f.advance(20 * DAY);
	await renewal.retained("original");
	f.advance(DAY);
	await renewal.renewIfDue();
	assert.equal(f.events.length, 0);
	assert.equal(f.alarm(), f.now() + 20 * DAY);
});

test("snapshot scheduling preserves work, and completed work leaves the renewal alarm armed", async () => {
	const f = fixture();
	const renewal = f.controller();
	const work = await renewal.scheduleWork(f.now() + 60_000);
	await renewal.retained("original");
	assert.equal(f.alarm(), f.now() + 60_000);
	await renewal.scheduleWork(null, work);
	assert.equal(f.alarm(), f.now() + 21 * DAY);
});

test("watchdog cleanup cannot erase new inbound work, even with the same deadline", async () => {
	const f = fixture();
	const renewal = f.controller();
	const old = await renewal.scheduleWork(f.now() + 60_000);
	const fresh = await renewal.scheduleWork(f.now() + 60_000);
	assert.notEqual(old, fresh);
	await renewal.scheduleWork(null, old);
	assert.equal(f.alarm(), f.now() + 60_000);
	f.advance(60_000);
	assert.equal(await renewal.workDue(), true);
	await renewal.scheduleWork(null, fresh);
	assert.equal(f.alarm(), null);
});

test("an idle watchdog can move to the shutdown deadline while newer messages retain their earlier check", async () => {
	const f = fixture();
	const renewal = f.controller();
	const work = await renewal.scheduleWork(f.now() + 60_000);
	const idle = await renewal.scheduleWork(f.now() + 5 * 60_000, work);
	assert.equal(f.alarm(), f.now() + 5 * 60_000);
	await renewal.scheduleWork(f.now() + 60_000);
	await renewal.scheduleWork(f.now() + 5 * 60_000, idle);
	assert.equal(f.alarm(), f.now() + 60_000);
});

test("an already running user computer is never restored or stopped", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.retained("original");
	const expiresAt = (await renewal.status()).expiresAt;
	f.advance(21 * DAY);
	f.container.running = true;
	await renewal.renewIfDue();
	assert.deepEqual(f.events, []);
	assert.equal(f.container.running, true);
	assert.equal((await renewal.status()).expiresAt, expiresAt, "deferral is not a successful renewal");
	assert.equal(f.alarm(), f.now() + HOUR);
});

test("a failed restore retains its ID and deadline, and retries after restart until it succeeds", async () => {
	const f = fixture();
	let renewal = f.controller();
	await renewal.retained("original");
	const expiresAt = (await renewal.status()).expiresAt;
	f.advance(21 * DAY);
	f.container.startError = new Error("Temporarily unavailable");
	for (let attempt = 1; attempt <= 8; attempt++) {
		await renewal.renewIfDue();
		const status = await renewal.status();
		assert.equal(status.failures, attempt);
		assert.equal(status.expiresAt, expiresAt);
		assert.match(status.lastError, /Temporarily unavailable/);
		assert.equal(f.alarm(), f.now() + HOUR);
		f.advance(HOUR);
		renewal = f.controller();
		await renewal.initialize();
	}
	f.container.startError = null;
	await renewal.renewIfDue();
	assert.equal(await f.storage.get(SNAPSHOT_KEY), "original");
	assert.equal((await renewal.status()).failures, 0);
	assert.equal((await renewal.status()).lastError, undefined);
	assert.equal((await renewal.status()).expiresAt, f.now() + 30 * DAY);
});

test("a failed readiness check stops its maintenance container and leaves an hourly retry", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.retained("original");
	f.advance(21 * DAY);
	f.container.exitCode = 1;
	await renewal.renewIfDue();
	assert.equal(f.container.running, false);
	assert.equal((await renewal.status()).failures, 1);
	assert.match((await renewal.status()).lastError, /readiness check/);
	assert.equal(f.alarm(), f.now() + HOUR);
});

test("expired snapshots are reported and retried, never replaced with an empty computer", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.retained("original");
	f.advance(31 * DAY);
	await renewal.renewIfDue();
	assert.equal(await f.storage.get(SNAPSHOT_KEY), "original");
	assert.match((await renewal.status()).lastError, /expired/);
	assert.equal(f.events.filter((e) => e.action === "start").length, 1);
	assert.equal(f.events[0].options.image, undefined);
});

test("older snapshots renew immediately while preserving an older watchdog alarm", async () => {
	const f = fixture();
	await f.storage.put(SNAPSHOT_KEY, "original");
	await f.storage.setAlarm(f.now() + 60_000);
	const renewal = f.controller();
	await renewal.initialize();
	assert.equal(f.alarm(), f.now());
	assert.equal((await renewal.status()).expiresAt, undefined, "legacy snapshot age is unknown");
	await renewal.renewIfDue();
	assert.equal(f.alarm(), f.now() + 60_000);
	f.advance(60_000);
	assert.equal(await renewal.workDue(), true);
});

test("user acquisition waits for maintenance cleanup before using the container", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.retained("original");
	f.advance(21 * DAY);
	let release;
	const blocked = new Promise((done) => { release = done; });
	let probing;
	const ready = new Promise((done) => { probing = done; });
	f.container.probe = async () => { probing(); await blocked; };
	const maintenance = renewal.renewIfDue();
	await ready;
	let userAcquired = false;
	const user = renewal.exclusive(async () => { assert.equal(f.container.running, false); userAcquired = true; });
	await Promise.resolve();
	assert.equal(userAcquired, false);
	release();
	await Promise.all([maintenance, user]);
	assert.equal(userAcquired, true);
	assert.equal(f.container.running, false);
});

test("chats without a snapshot do no maintenance and keep their conversation alarms", async () => {
	const f = fixture();
	const renewal = f.controller();
	await renewal.initialize();
	await renewal.renewIfDue(true);
	assert.equal(f.alarm(), null);
	assert.equal(await renewal.status(), null);
	await renewal.scheduleWork(f.now() + 60_000);
	await f.controller().initialize();
	assert.equal(f.alarm(), f.now() + 60_000);
	assert.deepEqual(f.events, []);
});
