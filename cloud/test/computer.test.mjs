import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxComputer } from "../src/computer.ts";
import { SnapshotRenewal } from "../src/snapshot-renewal.ts";

function fixture(snapshot) {
	const values = new Map(snapshot ? [["computer-snapshot", snapshot]] : []);
	let alarm = null;
	const storage = {
		get: async (key) => values.get(key), put: async (key, value) => { values.set(key, value); }, delete: async (key) => values.delete(key),
		getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
		transaction: async (work) => work(storage),
	};
	const starts = [], commands = [], killed = [];
	const container = {
		running: false, images: { sandbox: "test-image" },
		start(options) { starts.push(options); this.running = true; },
		setInactivityTimeout: async () => {},
		snapshotContainer: async () => ({ id: "new-snapshot" }),
		async exec(argv, options) {
			commands.push({ argv, options });
			if (argv[0] === "true") return { output: async () => ({ stdout: new ArrayBuffer(0), exitCode: 0 }) };
			let finish;
			const output = argv.at(-1) === "wait" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ stdout: new TextEncoder().encode("ok").buffer, exitCode: 0 });
			return { output: () => output, kill: (signal) => { killed.push(signal); finish?.({ stdout: new ArrayBuffer(0), exitCode: 137 }); } };
		},
	};
	const ctx = { storage, container, blockConcurrencyWhile: (work) => work() };
	const renewal = new SnapshotRenewal(storage, container);
	return { computer: new SandboxComputer(ctx, async () => {}, renewal), renewal, container, starts, commands, killed, values };
}

test("concurrent sandbox commands acquire one computer and restore its retained workspace", async () => {
	const f = fixture("old-snapshot");
	await f.renewal.initialize();
	const outputs = await Promise.all([f.computer.exec("first", new AbortController().signal), f.computer.exec("second", new AbortController().signal)]);
	assert.equal(f.starts.length, 1);
	assert.equal(f.starts[0].containerSnapshot.id, "old-snapshot");
	assert.deepEqual(outputs, [{ output: "ok", exitCode: 0 }, { output: "ok", exitCode: 0 }]);
	assert.ok(f.commands.filter((command) => command.argv[0] !== "true").every((command) => command.options.cwd === "/workspace"));
	assert.equal((await f.renewal.status()).snapshot, "old-snapshot");
	await f.computer.saveIfUsed();
	assert.equal(f.values.get("computer-snapshot"), "new-snapshot");
	assert.equal((await f.renewal.status()).snapshot, "new-snapshot");
});

test("cancelling a sandbox command kills the remote process rather than abandoning its wait", async () => {
	const f = fixture();
	const controller = new AbortController();
	const running = f.computer.exec("wait", controller.signal);
	while (!f.commands.some((command) => command.argv.at(-1) === "wait")) await new Promise((resolve) => setTimeout(resolve, 1));
	controller.abort();
	await assert.rejects(running, { name: "AbortError" });
	assert.deepEqual(f.killed, [9]);
});

test("idle reporting stops a saved computer without losing its snapshot or stopping unsaved work", async () => {
	const f = fixture();
	let stops = 0;
	f.container.destroy = async () => { stops++; f.container.running = false; };
	await f.computer.exec("first", new AbortController().signal);
	f.values.get("computer-session").lastUsedAt = Date.now() - 6 * 60_000;
	assert.ok(await f.computer.reportAt() > Date.now());
	assert.equal(stops, 0, "unsaved work keeps the computer alive");
	await f.computer.saveIfUsed();
	assert.equal(await f.computer.reportAt(), 0);
	assert.equal(stops, 1);
	assert.equal(f.container.running, false);
	assert.equal(f.values.get("computer-snapshot"), "new-snapshot");
	await f.computer.exec("second", new AbortController().signal);
	assert.equal(f.starts.length, 2);
	assert.equal(f.starts[1].containerSnapshot.id, "new-snapshot");
});
