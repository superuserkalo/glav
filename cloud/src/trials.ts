export const TRIAL_MS = 86_400_000;
export const TRIAL_CODE_LIMIT = 100;
const CODE_PATTERN = /\bGLAV-[A-F0-9]{32}\b/gi;
const CODE_FORMAT = /^GLAV-[A-F0-9]{32}$/;

export function trialCodeIn(text: string | undefined): string | undefined {
	const codes = [...new Set((text?.match(CODE_PATTERN) ?? []).map((code) => code.toUpperCase()))];
	return codes.length === 1 ? codes[0] : undefined;
}
async function hash(code: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type TrialResult = { status: "active"; startedAt: number; endsAt: number } | { status: "invalid" | "already_used" };
export type Campaign = { id: string; purpose: string; durationDays: number; limit: number | null; issued: number; enabled: boolean; mode: "start" | "extend"; redeemed: number; remaining: number | null; availableCodes: number };
type CampaignRow = { id: string; purpose: string; duration_ms: number; code_limit: number | null; issued: number; enabled: number; mode: "start" | "extend"; redeemed: number; available: number };
export class TrialLimitError extends Error {
	readonly remaining: number;
	readonly limit: number;
	constructor(remaining: number, limit = TRIAL_CODE_LIMIT) {
		super(`Only ${remaining} of this campaign's ${limit} codes remain available to issue.`);
		this.remaining = remaining; this.limit = limit;
	}
}

const TABLES = [
	`CREATE TABLE IF NOT EXISTS trial_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS trial_access (user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL)`,
	// Keep the old counter for the one-time migration, including slots already issued by the old Worker.
	`CREATE TABLE IF NOT EXISTS trial_campaign (id INTEGER PRIMARY KEY CHECK (id = 1), issued INTEGER NOT NULL CHECK (issued BETWEEN 0 AND 100))`,
	`CREATE TABLE IF NOT EXISTS access_schema (version INTEGER PRIMARY KEY)`,
	`CREATE TABLE IF NOT EXISTS access_campaigns (
		id TEXT PRIMARY KEY, purpose TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
		code_limit INTEGER CHECK (code_limit IS NULL OR code_limit >= issued), issued INTEGER NOT NULL CHECK (issued >= 0),
		enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), mode TEXT NOT NULL CHECK (mode IN ('start', 'extend')))`,
	`CREATE TABLE IF NOT EXISTS access_code_terms (code_hash TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, duration_ms INTEGER NOT NULL, mode TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS access_redemptions (code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, campaign_id TEXT NOT NULL,
		started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, UNIQUE (user_id, campaign_id))`,
	`INSERT INTO access_campaigns SELECT 'launch', 'Beta goodie', ${TRIAL_MS}, 100,
		COALESCE((SELECT issued FROM trial_campaign WHERE id = 1), (SELECT COUNT(*) FROM trial_codes) + (SELECT COUNT(*) FROM trial_access)), 1, 'start'
		WHERE NOT EXISTS (SELECT 1 FROM access_schema WHERE version = 1) ON CONFLICT DO NOTHING`,
	`INSERT INTO access_code_terms SELECT code_hash, 'launch', ${TRIAL_MS}, 'start' FROM trial_codes
		WHERE NOT EXISTS (SELECT 1 FROM access_schema WHERE version = 1) ON CONFLICT DO NOTHING`,
	`INSERT INTO access_redemptions SELECT code_hash, user_id, 'launch', started_at, ends_at FROM trial_access
		WHERE NOT EXISTS (SELECT 1 FROM access_schema WHERE version = 1) ON CONFLICT DO NOTHING`,
	`INSERT INTO access_schema VALUES (1) ON CONFLICT DO NOTHING`,
];

/** Owns campaign limits, frozen code terms, and atomic, replay-safe grants. Callers never choose redemption terms. */
export class Trials {
	private ready?: Promise<unknown>;
	private readonly db: D1Database;
	private readonly now: () => number;
	constructor(db: D1Database, now: () => number = Date.now) { this.db = db; this.now = now; }
	private ensure(): Promise<unknown> {
		return this.ready ??= this.db.batch(TABLES.map((sql) => this.db.prepare(sql))).catch((error) => { this.ready = undefined; throw error; });
	}
	async campaign(id = "launch"): Promise<Campaign | undefined> {
		await this.ensure();
		const row = await this.db.prepare(`SELECT c.*,
			(SELECT COUNT(*) FROM access_redemptions r WHERE r.campaign_id = c.id) AS redeemed,
			(SELECT COUNT(*) FROM trial_codes t JOIN access_code_terms m USING (code_hash) WHERE m.campaign_id = c.id AND t.expires_at > ?) AS available
			FROM access_campaigns c WHERE id = ?`).bind(this.now(), id).first<CampaignRow>();
		return row ? { id: row.id, purpose: row.purpose, durationDays: row.duration_ms / TRIAL_MS, limit: row.code_limit,
			issued: row.issued, enabled: !!row.enabled, mode: row.mode, redeemed: row.redeemed,
			remaining: row.code_limit === null ? null : row.code_limit - row.issued, availableCodes: row.available } : undefined;
	}
	async configure(id: string, patch: Partial<Pick<Campaign, "purpose" | "durationDays" | "limit" | "enabled" | "mode">> = {}): Promise<Campaign> {
		if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || Object.keys(patch).some((key) => !["purpose", "durationDays", "limit", "enabled", "mode"].includes(key))) throw new RangeError("Invalid campaign id or field.");
		const previous = await this.campaign(id);
		const value = { purpose: id, durationDays: 1, limit: null as number | null, enabled: true, mode: "start" as const, ...previous, ...patch };
		const duration = value.durationDays * TRIAL_MS;
		if (typeof value.purpose !== "string" || !value.purpose.trim() || value.purpose.length > 120 || typeof value.durationDays !== "number" || !Number.isSafeInteger(duration) || duration < 1
			|| value.limit !== null && (!Number.isSafeInteger(value.limit) || value.limit < (previous?.issued ?? 0))
			|| typeof value.enabled !== "boolean" || !["start", "extend"].includes(value.mode)) throw new RangeError("Invalid campaign terms; limit cannot be below issued codes.");
		await this.db.prepare(`INSERT INTO access_campaigns (id, purpose, duration_ms, code_limit, issued, enabled, mode) VALUES (?, ?, ?, ?, 0, ?, ?)
			ON CONFLICT (id) DO UPDATE SET purpose = excluded.purpose, duration_ms = excluded.duration_ms, code_limit = excluded.code_limit, enabled = excluded.enabled, mode = excluded.mode`)
			.bind(id, value.purpose, duration, value.limit, Number(value.enabled), value.mode).run();
		return (await this.campaign(id))!;
	}
	async issue(count = 1, validDays = 7, campaignId = "launch") {
		if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(validDays) || validDays < 1 || validDays > 365) throw new RangeError("Expected count 1-100 and validDays 1-365.");
		const campaign = await this.campaign(campaignId);
		if (!campaign?.enabled) throw new RangeError("Campaign is missing or disabled.");
		if (campaign.remaining !== null && count > campaign.remaining) throw new TrialLimitError(campaign.remaining, campaign.limit!);
		const createdAt = this.now(), expiresAt = createdAt + validDays * TRIAL_MS;
		const codes = Array.from({ length: count }, () => `GLAV-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
		const hashes = await Promise.all(codes.map(hash));
		try {
			const results = await this.db.batch([
				// CHECK constraints reserve the whole batch, even when issuers race or the campaign is disabled.
				this.db.prepare("UPDATE access_campaigns SET issued = CASE WHEN enabled = 1 THEN issued + ? ELSE -1 END WHERE id = ?").bind(count, campaignId),
				...hashes.flatMap((codeHash) => [
					this.db.prepare("INSERT INTO trial_codes VALUES (?, ?, ?)").bind(codeHash, createdAt, expiresAt),
					this.db.prepare("INSERT INTO access_code_terms SELECT ?, id, duration_ms, mode FROM access_campaigns WHERE id = ?").bind(codeHash, campaignId),
				]),
				this.db.prepare("SELECT code_limit - issued AS remaining, duration_ms FROM access_campaigns WHERE id = ?").bind(campaignId),
			]);
			const terms = results.at(-1)!.results[0] as { remaining: number | null; duration_ms: number };
			return { codes, expiresAt, remaining: terms.remaining, campaign: campaignId, durationDays: terms.duration_ms / TRIAL_MS };
		} catch (error) {
			const current = (await this.campaign(campaignId))!;
			if (current.remaining !== null && count > current.remaining) throw new TrialLimitError(current.remaining, current.limit!);
			throw error;
		}
	}
	async access(userId: number): Promise<{ startedAt: number; endsAt: number } | undefined> {
		await this.ensure();
		const grant = await this.db.prepare("SELECT started_at, ends_at FROM trial_access WHERE user_id = ? AND ends_at > ?").bind(userId, this.now()).first<{ started_at: number; ends_at: number }>();
		return grant ? { startedAt: grant.started_at, endsAt: grant.ends_at } : undefined;
	}
	async hasTrial(userId: number): Promise<boolean> {
		await this.ensure();
		return !!await this.db.prepare("SELECT 1 FROM trial_access WHERE user_id = ?").bind(userId).first();
	}
	async canRedeem(userId: number, code: string): Promise<boolean> {
		if (!Number.isSafeInteger(userId) || userId <= 0 || !CODE_FORMAT.test(code)) return false;
		await this.ensure();
		return !!await this.db.prepare(`SELECT 1 FROM trial_codes t JOIN access_code_terms m USING (code_hash) JOIN access_campaigns c ON c.id = m.campaign_id
			WHERE t.code_hash = ? AND t.expires_at > ? AND c.enabled = 1
			AND (c.code_limit IS NULL OR (SELECT COUNT(*) FROM access_redemptions r WHERE r.campaign_id = c.id) < c.code_limit)
			AND NOT EXISTS (SELECT 1 FROM access_redemptions r WHERE r.user_id = ? AND r.campaign_id = c.id)`)
			.bind(await hash(code), this.now(), userId).first();
	}
	async redeem(userId: number, code: string): Promise<TrialResult> {
		if (!Number.isSafeInteger(userId) || userId <= 0 || !CODE_FORMAT.test(code)) return { status: "invalid" };
		await this.ensure();
		const codeHash = await hash(code), now = this.now();
		const results = await this.db.batch([
			this.db.prepare(`INSERT INTO access_redemptions (code_hash, user_id, campaign_id, started_at, ends_at)
				SELECT t.code_hash, ?, c.id, ?, CASE WHEN m.mode = 'extend'
					THEN MAX(?, COALESCE((SELECT ends_at FROM trial_access WHERE user_id = ?), 0)) + m.duration_ms
					ELSE MAX(? + m.duration_ms, COALESCE((SELECT ends_at FROM trial_access WHERE user_id = ?), 0)) END
				FROM trial_codes t JOIN access_code_terms m USING (code_hash) JOIN access_campaigns c ON c.id = m.campaign_id
				WHERE t.code_hash = ? AND t.expires_at > ? AND c.enabled = 1
				AND (c.code_limit IS NULL OR (SELECT COUNT(*) FROM access_redemptions r WHERE r.campaign_id = c.id) < c.code_limit)
				ON CONFLICT DO NOTHING`).bind(userId, now, now, userId, now, userId, codeHash, now),
			this.db.prepare(`INSERT INTO trial_access (user_id, code_hash, started_at, ends_at)
				SELECT user_id, code_hash, started_at, ends_at FROM access_redemptions WHERE user_id = ? AND code_hash = ? AND ends_at > ?
				ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, started_at = MIN(trial_access.started_at, excluded.started_at), ends_at = MAX(trial_access.ends_at, excluded.ends_at)`)
				.bind(userId, codeHash, now),
			this.db.prepare("DELETE FROM trial_codes WHERE code_hash = ? AND EXISTS (SELECT 1 FROM access_redemptions WHERE user_id = ? AND code_hash = ?)").bind(codeHash, userId, codeHash),
			this.db.prepare("SELECT started_at, ends_at FROM access_redemptions WHERE user_id = ? AND code_hash = ?").bind(userId, codeHash),
		]);
		const grant = results[3]!.results[0] as { started_at: number; ends_at: number } | undefined;
		if (grant && grant.ends_at > now) return { status: "active", startedAt: grant.started_at, endsAt: grant.ends_at };
		return { status: await this.hasTrial(userId) ? "already_used" : "invalid" };
	}
}
