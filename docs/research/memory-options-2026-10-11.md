# Memory options for Glav

Checked against current first-party sources on 2026-10-11. This is a small research pass, not a live comparison of memory quality.

Files can implement useful personal memory. The difference from Mem0 or Supermemory is who builds extraction, updates, retrieval, and prompt injection. A file format does not supply those behaviors. Hosted free tiers mean building everything yourself is not automatically the cheapest experiment.

## Current hosted costs

| Option | Free allowance | First paid plan | Implication for one personal agent |
| --- | --- | --- | --- |
| Mem0 Platform | 10,000 add requests and 1,000 retrieval requests per month, one project | Starter $19/month, 50,000 adds and 5,000 retrievals | Free retrieval allowance averages about 33 calls/day over 30 days. |
| Supermemory API | $5 credits/month, full memory and search API | Pro $19/month includes $20 credits | Plain text memory ingestion is $0.005 per 1,000 unique SM tokens. One million such tokens costs $5 before other operations. |

These are current [Mem0 prices](https://mem0.ai/pricing) and [Supermemory prices](https://supermemory.ai/pricing/). Supermemory lists search/traversal at $0.005 per 1,000 queries and other operations at $0.10 per 1,000 operations. Credits cover those too. Neither allowance measures the main assistant model's context cost, and storage format does not remove that cost.

## What the services provide

Mem0 extracts facts, decisions, and preferences with an LLM. Its current add documentation describes additive storage, and hosted extraction can use previous messages sharing the same identifiers to resolve references. That is not a reason to claim it lacks automatic conflict handling. [Add documentation](https://docs.mem0.ai/core-concepts/memory-operations/add).

The more specific Dream documentation says Supersede and Merge run automatically on every hosted plan. Superseded facts remain visible in default reads; `latest_only=true` selects current facts. Merged duplicates hide by default but remain recorded. Higher-level pattern Synthesis requires Pro or above. The pricing page's broad Dream label therefore needs this qualification. [Dream documentation](https://docs.mem0.ai/platform/features/dream).

Mem0 search uses embeddings, filters, and optional reranking. Its open-source library lets you choose the model, embeddings, and storage, so self-hosting still carries provider and infrastructure costs. Current defaults include an OpenAI LLM, OpenAI embeddings, local Qdrant, and SQLite history. [Search documentation](https://docs.mem0.ai/core-concepts/memory-operations/search), [open-source overview](https://docs.mem0.ai/open-source/overview).

Supermemory documents atomic extracted facts with update, extension, and inference relationships, temporal expiry, and hybrid semantic retrieval. Those are claimed product behaviors, not quality measurements for Glav. [Product explanation](https://supermemory.ai/product/).

Supermemory maintains a profile for each namespace, with stable facts, recent context, and optional topic buckets. In API v5, profile retrieval and search are separate calls. Glav must put the results into its prompt. [Profile documentation](https://supermemory.ai/docs/concepts/user-profiles).

Its local server is free within a lite license limit and uses your chosen extraction model, with local embeddings available. The precise docs say the downloadable server is built from a non-public codebase, despite looser open-source wording on the product page. Public SDKs and components are open source. Release v0.0.7 specifies a 10,000-document cap. Check the actual license before a hosted product deployment. [Local documentation](https://supermemory.ai/docs/self-hosting/overview), [release notes](https://github.com/supermemoryai/supermemory/releases).

## Correction to the Letta claim

Letta reported 74.0% LoCoMo accuracy with GPT-4o mini and conversation histories attached as files. But those files were parsed and embedded, and the agent had semantic `search_files` alongside `grep`. Tool rules required `search_files` as the first call. This was not a plain grep-only or BM25-only test. It supports iterative file retrieval as a workable interface, not the claim that embeddings are unnecessary or that a local Markdown implementation will match hosted memory. [Letta experiment, 2025-08-12](https://www.letta.com/blog/benchmarking-ai-agent-memory/).

## Decision for the first Glav experiment

For a minimal implementation, keep a small always-injected profile, explicit remember/forget operations, and dated source-linked entries alongside the history Glav already retains. Automatic capture needs an actual write trigger; a nightly job is optional until usage justifies it. Existing Durable Object storage can hold this without waking the Linux computer.

If the priority is the least work to try automatic extraction and semantic recall, a hosted free tier is a fair candidate. Prefer a thin provider interface and retain Glav's own raw conversation history so a later migration stays possible. Evaluate changed preferences, paraphrased recall, standing facts on unrelated prompts, and deliberate forgetting before calling either approach good enough. Multiuser hosting also needs authenticated per-user isolation regardless of the provider.
