# Events and tickets

## Where things live

One Next.js app. `app/events-ui.tsx` contains the public event list, attendee sign-in and tickets, organiser forms and door screen. Routes are thin wrappers. `app/event/[id]` is a public event detail page. The owner pass still opens `/owner`. `app/shell.tsx` provides role-specific navigation; server checks remain authoritative.

`src/db/migrations/0100-events.sql` adds category, event, ticket-type, order, individual ticket, check-in and outside-refund audit rows. Migrations 0001–0004 and protected starter files are unchanged. `lib/accounts.ts` matches the reviewed portal file; public sign-up creates the starter's member role, labelled attendee here. Only the owner can add door staff. No browser value can grant a role.

`lib/events/orders.ts` owns inventory, brief holds, hosted payment, reconciliation, ticket issuance and seat release. Mutations lock the ticket type before the order. Paid tickets issue only after payments.checkout.get reports paid and captured funds exactly match amount and currency. Expired or cancelled holds never issue a late paid ticket; those payments require review. Checkout keys persist per order for safe retries. Unknown outcomes keep their key and hold. Free orders issue inside their reservation transaction.

`lib/events/data.ts` owns owner management, scoped attendee reads, CSV and check-in. A unique check-in row per ticket plus order/ticket locks refuse repeat entry and concurrent cancellations. The HTTP routes in `app/api/events/[action]/route.ts` authenticate and enforce roles. Attendee lists and codes are scoped by the signed-in user on the server; private payment references never reach list responses. Door staff receive a success label only, not attendee lists.

`lib/pramaan.ts` is the single capability HTTP client through the platform socket. The platform holds keys; do not add a direct service connection. `lib/email.ts` is the email module helper. Email is sent only after verifiedEmail, under an order-specific idempotency key. `lib/events/validation.ts`, `csv.ts` and `time.ts` validate server inputs, CSV quoting and event-local clocks.

Run `node scripts/migrate.mjs` with DATABASE_URL, then `pnpm dev --port 3470`. The immutable starter package has no db:migrate script; use that node command. `pnpm test` is serial through vitest.config.ts and needs a disposable Postgres database (DATABASE_URL or PRAMAAN_DATABASE_TEST_URL). `node scripts/walk.mjs` uses headless Playwright from WALK_PLAYWRIGHT_MODULE, without adding packages to the starter. `node scripts/check-contract.mjs` runs product-loop's contract gates. `.scratch` and `.evidence` stay uncommitted.

## Add a field

Add a migration numbered after 0100. Update the validated input, parameterised query and screen in data.ts and events-ui.tsx. Keep existing migrations intact. Money and order state remain server-owned.

## Add a page

Create an app route and reuse Frame. Register it in pramaan.kit.json and a feature manifest if it belongs in generated navigation. Add a journey and a browser check. Authenticate every private server request.

## Add a role

Use requireRole on the server and scope reads explicitly. Public signup always creates member (attendee). Only an owner action may create a privileged account. Navigation is convenience, never permission enforcement.

## Journeys that ship working

- create-event: owner creates an event and ticket type.
- edit-categories: owner adds a seeded-table category.
- add-door-staff: owner creates a door-only account.
- free-ticket: attendee signs up at checkout and receives a free ticket on screen.
- public-events: visitor browses events.
- owner-settings: one-use pass opens owner settings.
- password-reset-off: explains email recovery requirements.
- import-events: owner imports CSV event rows atomically.

Paid checkout and ticket email are needs-capability, proved against a fake platform in the local walk. Refund creation remains needs-capability. Random-code door checks and CSV downloads are proved separately by the walk. See GAPS.md for exact limitations.
