import { DatabaseSync } from "node:sqlite";

/** Execute the production SQL with real SQLite, including D1's atomic batch semantics. */
export function database(t) {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	let failDelete = false;
	let failInsert = false;
	let queue = Promise.resolve();
	const db = {
		prepare(sql) {
			let values = [];
			return {
				bind(...args) { values = args; return this; },
				async first() { return sqlite.prepare(sql).get(...values) ?? null; },
				async run() {
					if (failDelete && sql.startsWith("DELETE FROM trial_codes")) throw new Error("injected deletion failure");
					if (failInsert && sql.startsWith("INSERT INTO trial_codes")) throw new Error("injected code insert failure");
					const statement = sqlite.prepare(sql);
					return { results: statement.columns().length ? statement.all(...values) : (statement.run(...values), []) };
				},
			};
		},
		batch(statements) {
			const next = queue.then(async () => {
				sqlite.exec("BEGIN");
				try {
					const results = [];
					for (const statement of statements) results.push(await statement.run());
					sqlite.exec("COMMIT");
					return results;
				} catch (error) { sqlite.exec("ROLLBACK"); throw error; }
			});
			queue = next.catch(() => undefined);
			return next;
		},
	};
	return { db, sqlite, failDeletion: (value) => { failDelete = value; }, failInsertion: (value) => { failInsert = value; } };
}
