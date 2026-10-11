# OpenAI prompt cache

Cache reuse and actual input cost are priorities for Glav. The cloud bot uses the Responses API through the pinned Pi SDK. OpenAI Docs provides the [caching contract](https://developers.openai.com/api/docs/guides/prompt-caching) and [diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

## Request contract

- Keep base instructions, tool names, descriptions, schemas, and ordering stable. Append changing task data to the newest input or tool result; keep timestamps, request IDs, poll counts, and cache diagnostics out of base instructions.
- The access extension refreshes account entitlements, free allowance, and beta settings in a named system section before each request. On models supporting append-only system updates, new access sections preserve the original prefix and earlier messages. On models that fold later sections into the leading prompt, these changes can reduce cache reuse. The backend still independently enforces access before generation and tool execution.
- Preserve earlier messages and tool results. The SDK supports append-only system/tool updates on modern OpenAI models. Do not rebuild or edit earlier messages to reflect new state.
- Preserve the SDK's durable `ProviderDoc.sessionId` as `prompt_cache_key`, including across object eviction and deployments. The cache adapter never replaces it with a random per-request key.
- Models whose registry advertises `supportsExplicitPromptCacheMode` receive implicit caching with `ttl: "30m"`. An explicit boundary follows the initial developer instructions and the two latest tool results. This leaves one write slot for the implicit boundary. All historical text tool outputs use the same content-block shape, even when a boundary moves.
- Older models retain their SDK/organization defaults. Do not force modern options or assume every older model supports 24-hour retention. `cacheRetention: "none"` remains an opt-out.
- Poll snapshots are appended only when changed or absent from the active context. They remain ordinary input. A reset or compaction can cause the current snapshot to be appended again without rewriting earlier entries.

## Diagnostics and accounting

The adapter requests comparisons with the latest completed response for the same durable key. OpenAI's raw `response.completed` event supplies `prompt_cache_diagnostics`; the SDK supplies normalized usage and model/tier-aware costs. Incomplete, aborted, and failed responses never become diagnostic baselines. Diagnostic expiry or storage failures do not fail the model request.

Durable storage retains totals and the latest 50 request records: model, response ID, time, latency, service tier, cache reads/writes, input/output counts, SDK costs, and whitelisted diagnostic fields. It stores no additional prompt, answer, API key, or tool arguments. A repeated response ID in the retained history is counted once. `/status` includes these metrics; `POST /cache?chat=<id>` returns metrics alone. Both require `Authorization: Bearer <AGENT_SECRET>`.

`tokenHitRate` is total cached tokens divided by total input tokens, rather than an average of request percentages. Input tokens include ordinary input, cache reads, and cache writes. Input cost includes all three at their respective SDK rates; writes are not added on top of ordinary input cost.

## Verification

Run `npm run typecheck` and `GLAV_TEST_PORT=8798 GLAV_TEST_NO_COMPUTER=1 npm test`. Tests exercise actual serialized SDK/harness requests, stable prefixes and keys across restart, diagnostic capture, cost accounting, opt-out, telemetry failures, poll snapshot changes/reset, and operator authorization.

`npm run check:cache -- --report /tmp/glav-cache-check.json` makes ten **billed** requests using invented weather content and a fictional tool schema. It never exports Glav's prompts, tool declarations, conversation history, or poll data. It compares SDK defaults with the adapter on the same model and fixture, checks a changing suffix, append after controller recreation, and tool-result boundaries, and records an intentional prefix change. The prefix is deliberately long enough for caching; production prompts are never padded. The API key comes from `OPENAI_API_KEY` or `.dev.vars` and is never printed. Results must show measured reads; do not claim incremental savings if SDK defaults achieve the same cost.

Cache hits are not guaranteed. Cold requests, expiry, machine routing, model or reasoning changes, and compaction can reduce reuse. Modern models require at least 1,024 visible tokens for a cacheable prefix. Diagnostics are best effort and can be unavailable even when usage reports cache reads. Intentional context reduction should be judged by total cost, including writes, rather than hit rate alone.
