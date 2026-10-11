# Access, beta messaging, and trial campaigns

Everyone can send 20 free text-chat messages. Free users can ask questions, plan, and draft in chat; they cannot run agent tools, download attachments, transcribe audio, or start a sandbox. The lifetime allowance is stored in D1, survives `/new` and restarts, and charges each Telegram update once. An admitted message can recover after interruption without spending another slot. Valid trial activation remains available after all 20 messages are used and does not spend a free message.

Active trials, verified subscription entitlements, and the existing owner allowlist unlock the full agent. Trial and subscription access belongs to the account's private Telegram chat; group access still requires both an allowed sender and an allowed group. Expiry is checked before model requests and before every normal tool. A command already running when access expires can finish. Containers start on tool use, not merely because a free user has a conversation.

All operator endpoints below require `Authorization: Bearer <AGENT_SECRET>` and POST JSON. Responses containing operator data use `Cache-Control: no-store`. Do not place the secret or code lists in Git.

## Feature flags

`POST /access-settings` accepts a partial settings object; `{}` reads the current values. Settings take effect without deployment, and access facts refresh before each model request.

| Setting | Default | Effect |
| --- | --- | --- |
| `betaMode` | `true` | Enables limited-beta messaging and the configured offer. Turning it off removes scarcity and waitlist messaging without granting or revoking agent access. |
| `waitlistEnabled` | `true` | Enrolls free users into the beta waitlist and permits the model to mention their confirmed enrollment. |
| `codesEnabled` | `true` | Allows issuance and redemption of trial codes. Existing grants remain active when disabled. |
| `freeMessages` | `20` | Lifetime free-chat allowance per Telegram account. Raising it adds room without resetting usage. |
| `betaCampaign` | `launch` | Selects the offer described during beta onboarding. |
| `subscriptionMonthlyUsd` | `25` | Planned monthly price described in conversation. This setting does not charge anybody. |

`BETA_MODE` and `FREE_MESSAGES` provide deployment defaults; stored settings override them. Production needs no environment-variable change to use the defaults above.

To end beta messaging:

```json
{"betaMode":false}
```

Beta flags control conversation and enrollment. Campaign flags control individual offers. Retiring the one-day offer is a separate `POST /campaigns` request:

```json
{"id":"launch","enabled":false}
```

Retirement stops unused codes from activating; existing trial grants keep their original expiry. Disabling all codes is optional, and does not stop free conversation or existing subscription access.

## Campaigns and codes

The `launch` campaign has purpose `Beta goodie`, duration one day, limit 100 issued codes, and mode `start`. The original codes and redeemed grant migrate once with their exact terms. Issuance and activation caps remain intact. Used and expired codes never restore issuance slots.

`POST /campaigns` with `{"id":"launch"}` reads its terms and counters. Updates accept `purpose`, `durationDays`, `limit`, `enabled`, and `mode`. New campaign IDs are lowercase letters, digits, underscores, and hyphens. Limits are independently scoped to campaigns; `null` means unlimited issuance. A limit cannot be reduced below the number already issued. Durations may be any positive number of days that represents a safe integer number of milliseconds.

A separate three-day offer can be prepared while inactive:

```json
{"id":"standard","purpose":"Standard trial","durationDays":3,"limit":null,"enabled":false,"mode":"start"}
```

Later, enable it with `{"id":"standard","enabled":true}`. Each account can redeem one code per campaign, so an account that used the launch offer can separately use the standard offer. `start` grants access until at least now plus the code's duration and never shortens an existing trial. `extend` adds the duration to the later of now or the existing trial expiry; it is useful for rewards and extensions. Subscription expiry remains separate from trial expiry.

Generate codes using `POST /trial-codes`:

```sh
curl --fail-with-body "$GLAV_WORKER_URL/trial-codes" \
  -H "Authorization: Bearer $GLAV_OPERATOR_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"campaign":"launch","count":10,"validDays":7}'
```

`campaign` defaults to `launch`; `count` is 1–100 per request. `validDays` is 1–365 and controls unused-code validity, independently of trial duration. The response includes cleartext `codes`, `expiresAt` in Unix milliseconds, `campaign`, `durationDays`, and `remaining` issuance capacity (`null` for an unlimited campaign). Exceeding capacity returns HTTP 409 and creates no codes. Generating codes uses cryptographic randomness, not a model call.

Each code contains 128 bits of randomness, prefixed `GLAV-`. D1 stores only SHA-256 hashes. Terms are frozen when issued: changing a campaign duration affects future codes, while previously issued codes retain their duration and grant mode. Disabling a campaign affects all its unused codes.

A user sends a code in a private chat. The Worker rejects invalid, ambiguous, expired, consumed, or disabled candidates without a model call or attachment processing. A valid candidate exposes `activate_trial`; identity and the candidate code come from authenticated Telegram input. The model cannot choose an account, duration, or campaign. Free conversations expose only `activate_trial` and read-only `access_status`; a backend tool hook blocks all other tools even if a model requests one.

Activation inserts a permanent redemption receipt, updates trial access, and deletes the unused code in one [D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Unique constraints arbitrate concurrent claims. Retrying returns the original receipt without extending time, consuming another spot, or shortening a later extension. An ineligible user cannot burn somebody else's code.

## Waitlist and subscriptions

`POST /waitlist` with `{}` returns the waiting count and up to 100 oldest accounts. Enrollment is real and idempotent. Successful trial activation or verified subscription marks the account admitted. The model mentions limited beta access on introductions or access questions, uses real campaign facts, and avoids repeating the pitch during ordinary help. It never invents a queue position, a full capacity claim, a referral system, or a notification. Automatic invitation and waitlist notification delivery are not implemented.

Subscription entitlement is separate from trial campaigns. `POST /subscriptions` reads an account with `{"userId":123}` or records verified paid access with `{"userId":123,"endsAt":1799999999999,"reference":"verified-payment-reference"}`. `endsAt` is Unix milliseconds; `0` revokes subscription access. Only the operator can call this endpoint. After subscription expiry, the account can use its remaining free-chat allowance or a separately eligible trial.

Payment collection, checkout, renewal webhooks, and automatic subscription verification are not connected. Glav says the planned price is $25/month and directly explains that checkout is unavailable if asked to pay. The model cannot grant paid access or fabricate a payment link.

## Validation

The suite uses the real production SQL in SQLite and the real Worker under Wrangler with fake Telegram and model responses. It covers 20-message accounting, duplicate delivery, concurrency, restart and reset persistence, restricted tools, legacy migration, campaign limits, frozen terms, extensions, retirement, expiry, and operator authorization.

From `cloud`:

```sh
npm run typecheck
GLAV_TEST_NO_COMPUTER=1 npm test
```

The integration test disables containers and verifies that free chat and activation never download attachments. It does not run a real sandbox. An additional billed real-model prompt check uses synthetic accounts without sending Telegram messages or redeeming actual codes:

```sh
node scripts/check-access.mjs --report /tmp/glav-access-prompt-check.json
```
