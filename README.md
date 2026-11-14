# Gather — events and tickets

Create events, sell tickets in test mode and welcome attendees with one-use ticket check-in. Each attendee sees only their own orders and tickets. The owner adds door staff and edits event categories.

Use Node 24.18.0 and pnpm 11.15.1. Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Set DATABASE_URL, SESSION_SECRET (32+ characters), APP_ORIGIN and PRAMAAN_PROJECT_ID through your runtime. Run `node scripts/migrate.mjs`, then `pnpm dev --port 3470`. Local HTTP testing requires APP_COOKIE_SECURE=false. Open as owner through the platform's signed owner pass; public signup never grants ownership.

Payment and email modules are off by default. Set PRAMAAN_PAYMENTS_MODE=test only with a platform test payment connection. No direct vendor keys belong in this app. Refund creation is not available: paid seats release after the owner records a completed outside refund. See KIT.md and GAPS.md.

Checks: `pnpm typecheck`, `pnpm lint` on a clean tracked export, `pnpm test` with disposable Postgres, `pnpm build`, `node scripts/check-contract.mjs`, and `node scripts/walk.mjs` with WALK_PLAYWRIGHT_MODULE pointing to an existing Playwright installation.

MIT, Copyright (c) 2026 Sudo Sapient. Starter and block notices are in NOTICE.md and blocks.lock.json.

Local resource checks use the platform's `npm_config_verify_deps_before_run=false` and `pnpm_config_verify_deps_before_run=false` settings after install. On machines with many cores, `CIRCLE_NODE_TOTAL=2 pnpm build` keeps Next's page workers within the two-CPU check budget without changing the protected config. This environment setting does not replace hosted kit CI.

Full kit CI: runs in product-loop on pinning. Local gates pass. The red local `kit-ci.json` stays as it is; product-loop runs the full container checks in its pinning PR and commits the green record there.
