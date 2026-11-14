import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkin, exportAttendees, manage, tickets } from "./data";
import { orders } from "./orders";

const connectionString = process.env.PRAMAAN_DATABASE_TEST_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("Postgres tests require DATABASE_URL or PRAMAAN_DATABASE_TEST_URL.");
const schema = `test_events_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString, max: 1 }),
  db = new Pool({ connectionString, max: 3, options: `-c search_path=${schema}` });
const call = vi.fn(),
  send = vi.fn().mockResolvedValue({ status: "sent" });
const service = orders(db, { call }, { send }, async () => "confirmed@example.test");
const attendee = randomUUID(),
  other = randomUUID(),
  door = randomUUID();
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of (await readdir("src/db/migrations")).sort())
    await db.query(await readFile(`src/db/migrations/${file}`, "utf8"));
  for (const [n, user] of [attendee, other, door].entries())
    await db.query("INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,'unused',$3)", [
      user,
      `user${n}@example.test`,
      n === 2 ? "door" : "member",
    ]);
  process.env.PRAMAAN_PAYMENTS_MODE = "test";
});
afterAll(async () => {
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function type(price = 0, capacity = 1) {
  const event = randomUUID(),
    type = randomUUID();
  await db.query(
    "INSERT INTO events(id,title,venue,category_id,starts_at,ends_at,timezone) VALUES($1,'Test gathering','Town Hall','a1000000-0000-4000-8000-000000000001',now()+interval '1 day',now()+interval '2 days','Europe/London')",
    [event],
  );
  await db.query(
    "INSERT INTO ticket_types(id,event_id,name,price_cents,currency,capacity,sales_start,sales_end) VALUES($1,$2,'General', $3,'gbp',$4,now()-interval '1 day',now()+interval '1 day')",
    [type, event, price, capacity],
  );
  return { type, event };
}
const body = (type: string, quantity = 1) => ({ typeId: type, quantity, requestKey: randomUUID() });
const paid = (amount = 100, currency = "GBP") => ({
  ok: true,
  value: { status: "paid", payments: [{ status: "captured", amount: { amount, currency } }] },
});
describe("inventory, payments and access", () => {
  it("two concurrent free buyers cannot take the last seat", async () => {
    const t = await type();
    const r = await Promise.allSettled([
      service.reserve(attendee, body(t.type)),
      service.reserve(other, body(t.type)),
    ]);
    expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT * FROM event_tickets t JOIN event_orders o ON o.id=t.order_id WHERE o.type_id=$1",
          [t.type],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("holds the last paid seat without issuing unpaid tickets", async () => {
    const t = await type(100);
    const r = await Promise.allSettled([
      service.reserve(attendee, body(t.type)),
      service.reserve(other, body(t.type)),
    ]);
    expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT * FROM event_tickets t JOIN event_orders o ON o.id=t.order_id WHERE o.type_id=$1",
          [t.type],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("ignores browser price and status; only exact captured money issues tickets once", async () => {
    const t = await type(100);
    call.mockResolvedValueOnce({
      ok: true,
      value: { ref: randomUUID(), checkoutUrl: "https://checkout.example.test/pay" },
    });
    const started = await service.start(
      attendee,
      { ...body(t.type), unitCents: 1, status: "paid" },
      "http://localhost:3470",
    );
    expect(call.mock.calls.at(-1)?.[1].lineItems[0].amount).toBe(100);
    const order = await service.own(attendee, started.orderId);
    expect(order.status).toBe("held");
    for (const answer of [
      paid(99),
      paid(100, "USD"),
      {
        ok: true,
        value: {
          status: "paid",
          payments: [{ status: "authorised", amount: { amount: 100, currency: "GBP" } }],
        },
      },
      {
        ok: true,
        value: {
          status: "completed",
          payments: [{ status: "captured", amount: { amount: 100, currency: "GBP" } }],
        },
      },
    ]) {
      call.mockResolvedValueOnce(answer);
      await service.confirm(order);
      expect((await service.own(attendee, order.id)).status).toBe("held");
    }
    call.mockResolvedValue(paid());
    await Promise.all([service.confirm(order), service.confirm(order)]);
    expect((await service.own(attendee, order.id)).status).toBe("paid");
    expect(
      (await db.query("SELECT * FROM event_tickets WHERE order_id=$1", [order.id])).rowCount,
    ).toBe(1);
    await service.deliver(order.id);
    expect(send.mock.calls.at(-1)?.[0].text).toMatch(/[a-f0-9]{64}/u);
    await expect(service.release(order.id, attendee, false, false, "")).rejects.toThrow(
      "outside refund",
    );
  });
  it("expired holds release capacity and late paid results never oversell", async () => {
    const t = await type(100),
      a = await service.reserve(attendee, body(t.type));
    await db.query(
      "UPDATE event_orders SET hold_until=now()-interval '1 minute',checkout_ref=$2 WHERE id=$1",
      [a.id, randomUUID()],
    );
    await service.reserve(other, body(t.type));
    call.mockResolvedValueOnce(paid());
    await service.confirm(await service.own(attendee, a.id));
    expect((await service.own(attendee, a.id)).status).toBe("review");
    expect((await db.query("SELECT * FROM event_tickets WHERE order_id=$1", [a.id])).rowCount).toBe(
      0,
    );
  });
  it("cancelled unpaid checkout cannot issue tickets after payment", async () => {
    const t = await type(100),
      a = await service.reserve(attendee, body(t.type));
    await db.query("UPDATE event_orders SET checkout_ref=$2 WHERE id=$1", [a.id, randomUUID()]);
    await service.release(a.id, attendee, false, false, "");
    call.mockResolvedValueOnce(paid());
    await service.confirm(await service.own(attendee, a.id));
    expect((await service.own(attendee, a.id)).status).toBe("review");
  });
  it("retries one order and rejects changed quantity", async () => {
    const t = await type(100, 5),
      b = body(t.type);
    call.mockResolvedValue({
      ok: true,
      value: { ref: randomUUID(), checkoutUrl: "https://checkout.example.test/pay" },
    });
    const first = await service.start(attendee, b, "http://localhost:3470"),
      again = await service.start(attendee, b, "http://localhost:3470");
    expect(first.orderId).toBe(again.orderId);
    await expect(service.reserve(attendee, { ...b, quantity: 2 })).rejects.toThrow(
      "different tickets",
    );
  });
  it("cancelled free tickets free the seat and refuse entry", async () => {
    const t = await type(),
      a = await service.reserve(attendee, body(t.type));
    const code = (await db.query("SELECT code FROM event_tickets WHERE order_id=$1", [a.id]))
      .rows[0].code;
    await service.release(a.id, attendee, false, false, "");
    await expect(checkin(db, door, code)).rejects.toThrow("cancelled");
    expect((await service.reserve(other, body(t.type))).status).toBe("paid");
  });
  it("only one concurrent scan succeeds", async () => {
    const t = await type(),
      a = await service.reserve(attendee, body(t.type));
    const code = (await db.query("SELECT code FROM event_tickets WHERE order_id=$1", [a.id]))
      .rows[0].code;
    const result = await Promise.allSettled([checkin(db, door, code), checkin(db, door, code)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(checkin(db, door, code)).rejects.toThrow("already");
  });
  it("another attendee cannot read or cancel an order", async () => {
    const t = await type(),
      a = await service.reserve(attendee, body(t.type));
    expect(JSON.stringify(await tickets(db, other))).not.toContain(a.id);
    await expect(service.own(other, a.id)).rejects.toThrow("not found");
    await expect(service.release(a.id, other, false, false, "")).rejects.toThrow("not found");
  });
  it("outside refund requires owner and note, is audited and releases seat", async () => {
    const t = await type(100),
      a = await service.reserve(attendee, body(t.type));
    await db.query("UPDATE event_orders SET status='paid' WHERE id=$1", [a.id]);
    await expect(service.release(a.id, attendee, false, true, "Completed")).rejects.toThrow(
      "Only the owner",
    );
    await expect(service.release(a.id, door, true, true, "")).rejects.toThrow("note");
    await service.release(a.id, door, true, true, "Confirmed outside refund");
    expect((await service.reserve(other, body(t.type))).status).toBe("held");
    expect((await db.query("SELECT * FROM event_audit WHERE order_id=$1", [a.id])).rowCount).toBe(
      1,
    );
  });
  it("rejects closed sales and invalid quantity", async () => {
    const t = await type();
    await db.query(
      "UPDATE ticket_types SET sales_end=now()-interval '1 hour',sales_start=now()-interval '2 hours' WHERE id=$1",
      [t.type],
    );
    await expect(service.reserve(attendee, body(t.type))).rejects.toThrow("closed");
    await expect(service.reserve(attendee, body(t.type, 0))).rejects.toThrow("quantity");
  });
  it("category in use cannot be deleted; invalid import writes no partial events", async () => {
    const t = await type();
    await expect(
      manage(db, { action: "remove-category", id: "a1000000-0000-4000-8000-000000000001" }),
    ).rejects.toThrow("used");
    const before = (await db.query("SELECT count(*) AS n FROM events")).rows[0].n;
    await expect(
      manage(db, {
        action: "import",
        csv: "title,venue,category,startsAt,endsAt,timezone\nGood,Hall,Community,2027-01-01T18:00:00Z,2027-01-01T20:00:00Z,UTC\nBad,Hall,Community,bad,bad,UTC",
      }),
    ).rejects.toThrow();
    expect((await db.query("SELECT count(*) AS n FROM events")).rows[0].n).toBe(before);
    expect(await exportAttendees(db, t.event)).toContain("Ticket code");
  });
  it("requires explicit server test-mode setting", async () => {
    const t = await type(100);
    delete process.env.PRAMAAN_PAYMENTS_MODE;
    try {
      await expect(service.reserve(attendee, body(t.type))).rejects.toThrow("not switched on");
    } finally {
      process.env.PRAMAAN_PAYMENTS_MODE = "test";
    }
  });
});
