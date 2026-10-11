# Glav

Glav is one TypeScript application: a Telegram webhook, durable agent conversations, and a Linux sandbox per chat. The managed service, an operator's self-hosted deployment, and local development all run this application with the same storage, tools, and sandbox image.

`DEPLOYMENT_MODE` selects the access policy. In `hosted` mode, Glav manages free conversation, trials, and subscription entitlements. In `self-hosted` mode, users listed in `ALLOWED_USERS` have full agent access using the operator's credentials, with no Glav quota or subscription. Both the sender and destination group must be allowed. An empty self-hosted allowlist admits nobody. The operator pays their own model and infrastructure providers.

Install with Node 24 or newer:

```sh
npm ci
```

For self-hosted local development, copy `cloud/.dev.vars.example` to `cloud/.dev.vars.self-hosted`, fill in your Telegram and model credentials, generate distinct random `WEBHOOK_SECRET` and `AGENT_SECRET` values, and set your Telegram user ID in `ALLOWED_USERS`:

```sh
npm run dev -- --env self-hosted
```

Docker is required for the Linux sandbox. Wrangler runs the Worker, Durable Objects, and D1 locally. Use a development bot and public webhook forwarding to receive actual Telegram updates. `npm run dev` selects the managed deployment configuration instead.

To host your own bot, use the `self-hosted` environment in `cloud/wrangler.jsonc`. Set `env.self-hosted.vars.ALLOWED_USERS` and, if desired, change its Worker and database names. Log into your own Cloudflare account and deploy:

```sh
npx wrangler login
npm run deploy -- --env self-hosted
```

Wrangler provisions the self-hosted D1 database in your account; this environment never uses the managed service's database ID. See [Cloudflare resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/). The database tables initialize in the application, and Wrangler installs the Durable Object migration.

Supply your production credentials through Wrangler's secret prompts:

```sh
npx wrangler secret put TELEGRAM_KEY --config cloud/wrangler.jsonc --env self-hosted
npx wrangler secret put OPENAI_API_KEY --config cloud/wrangler.jsonc --env self-hosted
npx wrangler secret put WEBHOOK_SECRET --config cloud/wrangler.jsonc --env self-hosted
npx wrangler secret put AGENT_SECRET --config cloud/wrangler.jsonc --env self-hosted
```

Then register the webhook and command menu against your deployed Worker:

```sh
curl -X POST -H 'Authorization: Bearer <your AGENT_SECRET>' https://<your-worker>/setup
```

The managed service's default configuration retains its existing database. Its subscription entitlement checks are implemented, but payment checkout and payment-provider verification are not connected yet. A verified operator can grant subscription access through the existing guarded endpoint; the model and user cannot grant it.

Run checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run build -- --env self-hosted
```

The tests use a stand-in model and Telegram server and exercise both deployment modes, durable recovery, account enforcement, and sandbox files. Set `GLAV_TEST_NO_COMPUTER=1` to run without Docker. Builds are Wrangler deployment dry runs. These checks do not call a billed model or register a real bot.

Skills live in each chat's sandbox at `/workspace/.agents/skills/<skill-name>/SKILL.md`. Glav discovers their names and descriptions before each model turn, then reads the relevant instructions when needed. See [skills](docs/skills.md) for the format and installation.

See [the architecture](docs/architecture.md) for runtime ownership and persistence. Legacy local history and credentials remain on disk, but this application uses Durable Object storage; importing the old Node SQLite history is not implemented.
