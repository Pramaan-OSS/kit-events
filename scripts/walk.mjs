// Headless acceptance: every working checklist, then paid checkout, email, door, races and server isolation.
// Set WALK_BROWSER_MODULE to an installed @playwright/test (its index.mjs); the starter dependencies stay unchanged.
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { startFakeDoor } from "./fake-door.mjs";

const browserModule = process.env.WALK_BROWSER_MODULE ?? process.env.WALK_PLAYWRIGHT_MODULE;
const { chromium, expect } = await import(
  browserModule ? pathToFileURL(browserModule).href : "@playwright/test"
);
const port = Number(process.env.WALK_PORT ?? 3470),
  origin = `http://127.0.0.1:${port}`,
  secret = randomBytes(32).toString("hex"),
  project = "events-local";
if (!process.env.DATABASE_URL) throw Error("Use a disposable DATABASE_URL for the walk.");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
mkdirSync(".evidence", { recursive: true });
const doorDir = path.resolve(".evidence/door"),
  checks = [],
  journeys = [],
  errors = [];
let appPeak = 0,
  browserPeak = 0;
function rss(root) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/u).map(Number));
  const tree = new Set([root]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, ppid] of rows)
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
  }
  return Math.ceil(rows.filter(([pid]) => tree.has(pid)).reduce((n, [, , r]) => n + r, 0) / 1024);
}
function pass(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      role: "owner",
      project,
      iat: now,
      exp: now + 60,
      nonce: randomBytes(18).toString("base64url"),
      ...overrides,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
async function serve(withDoor) {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        SESSION_SECRET: secret,
        PRAMAAN_PROJECT_ID: project,
        APP_ORIGIN: origin,
        APP_COOKIE_SECURE: "false",
        PRAMAAN_PAYMENTS_MODE: withDoor ? "test" : "off",
        PRAMAAN_MODULES_DIR: withDoor ? doorDir : path.resolve(".evidence/no-door"),
      },
    },
  );
  const timer = setInterval(() => {
    try {
      appPeak = Math.max(appPeak, rss(child.pid));
    } catch {}
  }, 200);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return async () => {
    clearInterval(timer);
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
}
async function reset() {
  await db.query("TRUNCATE app_users,app_owner_passes,events,event_categories CASCADE");
  await db.query(
    "INSERT INTO event_categories VALUES('a1000000-0000-4000-8000-000000000001','Community'),('a1000000-0000-4000-8000-000000000002','Workshop'),('a1000000-0000-4000-8000-000000000003','Performance')",
  );
}
const browserServer = await chromium.launchServer({ headless: true });
const browser = await chromium.connect(browserServer.wsEndpoint());
const bt = setInterval(() => {
  try {
    browserPeak = Math.max(browserPeak, rss(browserServer.process().pid));
  } catch {}
}, 250);
const context = () =>
  browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
async function page(ctx) {
  const p = await ctx.newPage();
  p.setDefaultTimeout(12000);
  p.on("pageerror", (e) => errors.push(e.message));
  return p;
}
// As the gate does: enterAs opens a fresh browser at home (signed out; the owner's signs in with a pass), and an
// enterAs with "as" returns to that named person's browser.
async function enter(run, s) {
  const key = `${s.enterAs}\u0000${s.as ?? ""}`;
  if (s.as && run.named.has(key)) return run.named.get(key);
  const ctx = await context();
  run.contexts.push(ctx);
  const p = await page(ctx);
  await p.goto(s.enterAs === "owner" ? `/api/account/owner-pass?token=${pass()}` : "/");
  if (s.as) run.named.set(key, p);
  return p;
}
async function step(p, ctx, s) {
  if (s.enterAs === "owner") await p.goto(`/api/account/owner-pass?token=${pass()}`);
  else if (s.goto) await p.goto(s.goto);
  else if (s.fill) await p.getByLabel(s.fill, { exact: true }).fill(s.value);
  else if (s.select)
    await p.getByLabel(s.select, { exact: true }).selectOption({ label: s.option });
  else if (s.click)
    await p
      .getByRole("button", { name: s.click, exact: true })
      .or(p.getByRole("link", { name: s.click, exact: true }))
      .click();
  else if (s.expectText)
    await expect(p.getByText(s.expectText, { exact: false }).first()).toBeVisible();
  else if (s.expectHeading)
    await expect(p.getByRole("heading", { name: s.expectHeading, exact: true })).toBeVisible();
  else throw Error("Unsupported checklist step");
}
// As kit CI does: who the app says is signed in at each check, and a journey not for the owner or a visitor needs one
// check signed in, in a browser entered as its own role.
async function sessionRole(p) {
  const r = await p.request.get("/api/account/session");
  return r.ok() ? ((await r.json()).user?.role ?? null) : null;
}
function provenSignedIn(j, roles, seen) {
  if (j.role === "owner") return seen.some((s) => s.as === "owner" && s.role === "owner");
  if (roles[j.role]?.source === "anonymous") return true;
  return seen.some((s) => s.as === j.role && typeof s.role === "string" && s.role !== "owner");
}
const note = (s) => {
  checks.push(s);
  console.log(`Passed ${s}`);
};
const json = async (ctx, url, body) => {
  const response =
    body === undefined
      ? await ctx.request.get(url)
      : await ctx.request.post(url, { data: body, headers: { origin } });
  return { status: response.status(), body: await response.json() };
};
async function signUp(ctx, email) {
  const p = await page(ctx);
  await p.goto("/signin");
  await p.getByRole("button", { name: "New here? Create attendee account" }).click();
  await p.getByLabel("Email", { exact: true }).fill(email);
  await p.getByLabel("Password", { exact: true }).fill("Attendee-test-passphrase-23");
  await p.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(p.getByRole("heading", { name: "Make room for something good." })).toBeVisible();
  return p;
}
let stop;
const door = await startFakeDoor({ dir: doorDir, port: port + 1 });
try {
  stop = await serve(false);
  const manifest = JSON.parse(readFileSync("pramaan.kit.json", "utf8"));
  for (const j of manifest.journeys.filter((j) => j.status === "ships-working")) {
    await reset();
    const run = { contexts: [await context()], named: new Map() };
    let p = await page(run.contexts[0]);
    const seen = [];
    try {
      for (const item of JSON.parse(readFileSync(j.checklist, "utf8")).items) {
        let as = null;
        for (const s of item.steps) {
          if (s.enterAs) [p, as] = [await enter(run, s), s.enterAs];
          else await step(p, null, s);
          if (Object.keys(s).some((k) => k.startsWith("expect")))
            seen.push({ as, role: await sessionRole(p) });
        }
      }
      if (!provenSignedIn(j, manifest.roles, seen))
        throw Error(`no check ran signed in as ${j.role}: ${JSON.stringify(seen)}`);
      await p.screenshot({ path: `.evidence/${j.id}.png`, fullPage: true });
      journeys.push({ id: j.id, ok: true });
      console.log(`Passed journey ${j.id}`);
    } catch (e) {
      await p.screenshot({ path: `.evidence/failed-${j.id}.png`, fullPage: true });
      throw Error(`${j.id}: ${e.message}`);
    } finally {
      for (const ctx of run.contexts) await ctx.close();
    }
  }
  await stop();
  stop = undefined;
  await reset();
  stop = await serve(true);
  const owner = await context(),
    op = await page(owner);
  const token = pass();
  await op.goto(`/api/account/owner-pass?token=${token}`);
  await expect(op.getByRole("heading", { name: "Owner area" })).toBeVisible();
  for (const invalid of [
    token,
    pass({ exp: Math.floor(Date.now() / 1000) - 1 }),
    pass({ project: "other" }),
    `${pass()}forged`,
  ]) {
    const response = await owner.request.get(`/api/account/owner-pass?token=${invalid}`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
  }
  note("one-use, expired, foreign and forged owner passes");
  // Build the event using the actual owner screens and the same checklist actions.
  const created = manifest.journeys.find((j) => j.id === "create-event");
  for (const s of JSON.parse(readFileSync(created.checklist, "utf8")).items[0].steps)
    await step(op, owner, s);
  let cat = (await json(owner, "/api/events/catalog")).body;
  const event = cat.events[0];
  await json(owner, "/api/events/manage", {
    action: "type",
    eventId: event.id,
    name: "Paid admission",
    priceCents: 1250,
    currency: "gbp",
    capacity: 1,
    salesStart: "2020-01-01T00:00:00Z",
    salesEnd: "2030-06-15T17:00:00Z",
  });
  const staff = await json(owner, "/api/events/manage", {
    action: "staff",
    email: "delivered+events-door-2@resend.dev",
    password: "Door-test-passphrase-23",
  });
  expect(staff.status).toBe(200);
  await op.close();
  const a = await context(),
    ap = await signUp(a, "delivered+events-alice@resend.dev");
  // The confirmation is delivered through the fake email module, never marked from the browser.
  await expect
    .poll(() =>
      door.mail.find(
        (m) =>
          m.to === "delivered+events-alice@resend.dev" && m.text.includes("/api/account/verify?"),
      ),
    )
    .toBeTruthy();
  const link = door.mail
    .find(
      (m) =>
        m.to === "delivered+events-alice@resend.dev" && m.text.includes("/api/account/verify?"),
    )
    .text.match(/http[^\s]+\/api\/account\/verify\?token=[^\s]+/u)?.[0];
  expect(link).toBeTruthy();
  await ap.goto(link);
  const b = await context(),
    bp = await signUp(b, "delivered+events-bob@resend.dev");
  await bp.close();
  cat = (await json(a, "/api/events/catalog")).body;
  const paid = cat.events[0].types.find((t) => t.name === "Paid admission");
  await ap.goto(`/event/${event.id}`);
  const paidForm = ap
    .locator("form")
    .filter({ has: ap.getByRole("heading", { name: "Paid admission" }) });
  await paidForm.getByRole("button", { name: "Get tickets" }).click();
  await expect(ap.getByRole("heading", { name: "Test payment page" })).toBeVisible();
  let aOrders = (await json(a, "/api/events/tickets")).body.orders;
  expect(aOrders[0].status).toBe("held");
  expect(aOrders[0].tickets).toHaveLength(0);
  // Use a valid UUID for a second attempt: the capacity guard, not validation, must refuse it.
  const { randomUUID } = await import("node:crypto");
  const lastSeat = await json(b, "/api/events/checkout", {
    typeId: paid.id,
    quantity: 1,
    requestKey: randomUUID(),
  });
  expect(lastSeat.status).toBe(409);
  await ap.getByRole("button", { name: "Pay in test mode" }).click();
  await expect(ap.getByText("Ready for the door", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      door.mail.find(
        (m) =>
          m.to === "delivered+events-alice@resend.dev" && m.subject.startsWith("Your tickets:"),
      ),
    )
    .toBeTruthy();
  aOrders = (await json(a, "/api/events/tickets")).body.orders;
  const order = aOrders[0],
    code = order.tickets[0].code;
  expect(order.status).toBe("paid");
  expect(door.mail.find((m) => m.subject.startsWith("Your tickets:")).text).toContain(code);
  note("test payment issues one ticket and emails its code after authoritative paid result");
  const isolation = [
    await json(b, "/api/events/tickets"),
    await json(b, "/api/events/refresh", { orderId: order.id }),
    await json(b, "/api/events/cancel", { orderId: order.id }),
    await json(b, `/api/events/attendees?event=${event.id}`),
    await json(b, "/api/events/checkin", { code }),
  ];
  expect(isolation[0].body.orders).toHaveLength(0);
  expect(isolation.slice(1).map((r) => r.status)).toEqual([404, 404, 403, 403]);
  for (const r of isolation) expect(JSON.stringify(r.body)).not.toContain(code);
  note("second attendee server responses contain no private order, code or attendee list");
  await ap.close();
  const d = await context(),
    dp = await page(d);
  await dp.goto("/signin");
  await dp.getByLabel("Email", { exact: true }).fill("delivered+events-door-2@resend.dev");
  await dp.getByLabel("Password", { exact: true }).fill("Door-test-passphrase-23");
  await dp.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dp.getByRole("heading", { name: "Make room for something good." })).toBeVisible();
  await dp.goto("/door");
  await dp.getByLabel("Ticket code", { exact: true }).fill(code);
  await dp.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(dp.getByRole("status")).toContainText("Checked in");
  await dp.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(dp.getByRole("status")).toContainText("already been checked in");
  for (const [url, body] of [
    ["/api/events/manage", { action: "category", name: "Denied" }],
    ["/api/events/outside-refund", { orderId: order.id, note: "Denied" }],
    ["/api/events/checkout", { typeId: paid.id, quantity: 1, requestKey: randomUUID() }],
  ])
    expect((await json(d, url, body)).status).toBe(403);
  expect((await json(d, "/api/events/tickets")).status).toBe(403);
  expect((await json(d, `/api/events/attendees?event=${event.id}`)).status).toBe(403);
  note("door signs in, checks in once, repeat refused; staff permissions enforced");
  const exported = await owner.request.get(`/api/events/export?event=${event.id}`);
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain("delivered+events-alice@resend.dev");
  expect(await exported.text()).toContain(code);
  expect((await b.request.get(`/api/events/export?event=${event.id}`)).status()).toBe(403);
  note("attendee CSV bytes and export permissions");
  const released = await json(owner, "/api/events/outside-refund", {
    orderId: order.id,
    note: "Test: confirmed completed outside refund",
  });
  expect(released.status).toBe(200);
  cat = (await json(owner, "/api/events/catalog")).body;
  expect(cat.events[0].types.find((t) => t.id === paid.id).available).toBe(1);
  expect((await json(d, "/api/events/checkin", { code })).status).toBe(409);
  note("recorded outside refund releases capacity and cancels ticket");
  const raceType = (
    await json(owner, "/api/events/manage", {
      action: "type",
      eventId: event.id,
      name: "Last place",
      priceCents: 0,
      currency: "gbp",
      capacity: 1,
      salesStart: "2020-01-01T00:00:00Z",
      salesEnd: "2030-06-15T17:00:00Z",
    })
  ).body.id;
  const race = await Promise.all([
    json(a, "/api/events/checkout", { typeId: raceType, quantity: 1, requestKey: randomUUID() }),
    json(b, "/api/events/checkout", { typeId: raceType, quantity: 1, requestKey: randomUUID() }),
  ]);
  expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  note("two simultaneous server checkouts for the last seat produce one winner");
  const cancellationPage = await page(owner);
  await cancellationPage.goto("/organiser");
  await cancellationPage
    .getByLabel("Attendees for event", { exact: true })
    .selectOption({ label: event.title });
  const freeRow = cancellationPage.getByRole("row").filter({ hasText: "Last place" });
  await freeRow.getByRole("button", { name: "Cancel & release", exact: true }).click();
  await expect(freeRow).toContainText("cancelled");
  await expect
    .poll(async () => {
      const result = await json(owner, "/api/events/catalog");
      return result.body.events[0].types.find((t) => t.id === raceType).available;
    })
    .toBe(1);
  await cancellationPage.close();
  note("owner cancels a free order through the organiser screen and its seat returns");

  const visitor = await context();
  for (const url of [
    "/api/events/tickets",
    "/api/events/staff",
    `/api/events/export?event=${event.id}`,
  ])
    expect((await visitor.request.get(url)).status()).toBe(401);
  note("signed-out private requests refused");
  const attemptedOwner = await json(visitor, "/api/account/signup", {
    email: "delivered+events-role-attempt@resend.dev",
    password: "Attendee-test-passphrase-23",
    role: "owner",
  });
  expect(attemptedOwner.body.user.role).toBe("member");
  expect(
    (await json(visitor, "/api/events/manage", { action: "category", name: "Denied" })).status,
  ).toBe(403);
  expect(
    (await json(visitor, "/api/events/outside-refund", { orderId: order.id, note: "Denied" }))
      .status,
  ).toBe(403);
  note("browser-supplied owner role and attendee management/refund attempts refused");

  await dp.close();
  for (const [ctx, url, name] of [
    [a, "/tickets", "attendee"],
    [owner, "/organiser", "organiser"],
    [d, "/door", "door"],
    [b, "/", "public"],
  ]) {
    const p = await page(ctx);
    await p.goto(url);
    await p.screenshot({ path: `.evidence/${name}-desktop.png`, fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: `.evidence/${name}-mobile.png`, fullPage: true });
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await p.close();
  }
  note("desktop and 390px screens without sideways scrolling or page errors");
  expect(errors).toEqual([]);
  for (const ctx of [owner, a, b, d, visitor]) await ctx.close();
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify(
      { journeys, checks, errors, appPeakMiB: appPeak, browserPeakMiB: browserPeak },
      null,
      2,
    ),
  );
  console.log(
    `Walk passed: ${journeys.length} journeys, ${checks.length} checks; app ${appPeak} MiB, browser ${browserPeak} MiB`,
  );
} finally {
  if (stop) await stop();
  clearInterval(bt);
  await browser.close();
  await browserServer.close();
  await door.close();
  await db.end();
}
