import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashPassword } from "../accounts";
import { csv, parseCsv } from "./csv";
import { bad, eventInput, id, instant, integer, text } from "./validation";
export async function catalog(db: Pool) {
  const events = (
    await db.query(
      `SELECT e.*,c.name AS category FROM events e JOIN event_categories c ON c.id=e.category_id ORDER BY e.starts_at DESC LIMIT 500`,
    )
  ).rows;
  const types = (
    await db.query(
      `SELECT t.*,GREATEST(0,t.capacity-coalesce((SELECT sum(o.quantity) FROM event_orders o WHERE o.type_id=t.id AND (o.status='paid' OR (o.status='held' AND o.hold_until>now()))),0))::int AS available FROM ticket_types t ORDER BY t.price_cents,t.name`,
    )
  ).rows;
  const categories = (await db.query("SELECT * FROM event_categories ORDER BY name")).rows;
  return {
    events: events.map((e) => ({ ...e, types: types.filter((t) => t.event_id === e.id) })),
    categories,
  };
}
async function insertEvent(tx: Pool | PoolClient, b: Record<string, unknown>) {
  const e = eventInput(b),
    eid = randomUUID();
  if (!(await tx.query("SELECT id FROM event_categories WHERE id=$1", [e.category])).rowCount)
    throw bad("Choose an event category.");
  await tx.query(
    "INSERT INTO events(id,title,venue,category_id,starts_at,ends_at,timezone) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [eid, e.title, e.venue, e.category, e.start, e.end, e.timezone],
  );
  return { id: eid };
}
export async function manage(db: Pool, body: Record<string, unknown>) {
  if (body.action === "event") return insertEvent(db, body);
  if (body.action === "category") {
    const name = text(body.name, "a category name", 80);
    if (body.id)
      await db.query("UPDATE event_categories SET name=$2 WHERE id=$1", [id(body.id), name]);
    else
      await db.query("INSERT INTO event_categories(id,name) VALUES($1,$2)", [randomUUID(), name]);
    return { saved: true };
  }
  if (body.action === "remove-category") {
    try {
      await db.query("DELETE FROM event_categories WHERE id=$1", [id(body.id)]);
    } catch (e) {
      if ((e as { code: string }).code === "23503")
        throw bad("This category is used by an event. Move the event first.", 409);
      throw e;
    }
    return { removed: true };
  }
  if (body.action === "move-category") {
    await db.query("UPDATE events SET category_id=$2 WHERE id=$1", [
      id(body.id),
      id(body.categoryId),
    ]);
    return { saved: true };
  }
  if (body.action === "type") {
    const eventId = id(body.eventId),
      name = text(body.name, "a ticket name", 100);
    const start = instant(body.salesStart),
      end = instant(body.salesEnd);
    if (start >= end) throw bad("Sales must end after they start.");
    const currency = ["gbp", "usd", "eur", "inr"].find((c) => c === body.currency);
    if (!currency) throw bad("Choose a currency.");
    const eid = randomUUID();
    if (!(await db.query("SELECT id FROM events WHERE id=$1", [eventId])).rowCount)
      throw bad("That event was not found.", 404);
    await db.query(
      "INSERT INTO ticket_types(id,event_id,name,price_cents,currency,capacity,sales_start,sales_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        eid,
        eventId,
        name,
        integer(body.priceCents, 0, 99999999, "a price in minor units"),
        currency,
        integer(body.capacity, 1, 100000, "a capacity"),
        start,
        end,
      ],
    );
    return { id: eid };
  }
  if (body.action === "staff") {
    const email = text(body.email, "an email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw bad("Enter a valid email.");
    const password = text(body.password, "a password", 1024);
    if (password.length < 12) throw bad("Use at least 12 characters for the staff password.");
    const hash = await hashPassword(password);
    const r = await db.query(
      "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,'door') ON CONFLICT(email) DO NOTHING RETURNING id",
      [randomUUID(), email, hash],
    );
    if (!r.rowCount) throw bad("That email already has an account.", 409);
    return { added: true };
  }
  if (body.action === "import") {
    const rows = parseCsv(text(body.csv, "CSV content", 12000));
    const headers = ["title", "venue", "category", "startsAt", "endsAt", "timezone"];
    if (JSON.stringify(rows.shift()) !== JSON.stringify(headers))
      throw bad(`Use this header: ${headers.join(",")}`);
    if (!rows.length) throw bad("Add at least one event.");
    const cats = (await db.query("SELECT * FROM event_categories")).rows;
    const inputs = rows.map((r, n) => {
      if (r.length !== 6) throw bad(`Row ${n + 2} must have six fields.`);
      const c = cats.find((c) => c.name === r[2]);
      if (!c) throw bad(`Row ${n + 2}: choose an existing category.`);
      return {
        title: r[0],
        venue: r[1],
        categoryId: c.id,
        startsAt: r[3],
        endsAt: r[4],
        timezone: r[5],
      };
    });
    inputs.forEach(eventInput);
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      for (const b of inputs) await insertEvent(tx, b);
      await tx.query("COMMIT");
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally {
      tx.release();
    }
    return { imported: inputs.length };
  }
  throw bad("Choose a supported action.");
}
export async function tickets(db: Pool, userId: string) {
  const orders = (
    await db.query(
      `SELECT o.id,o.quantity,o.unit_cents,o.currency,o.status,o.hold_until,o.email_status,t.name AS type_name,e.title,e.venue,e.starts_at,e.ends_at,e.timezone FROM event_orders o JOIN ticket_types t ON t.id=o.type_id JOIN events e ON e.id=t.event_id WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 100`,
      [userId],
    )
  ).rows;
  const tickets = (
    await db.query(
      `SELECT t.id,t.code,t.order_id,t.cancelled_at,c.checked_at FROM event_tickets t JOIN event_orders o ON o.id=t.order_id LEFT JOIN event_checkins c ON c.ticket_id=t.id WHERE o.user_id=$1 ORDER BY t.created_at DESC LIMIT 1000`,
      [userId],
    )
  ).rows;
  return {
    orders: orders.map((o) => ({ ...o, tickets: tickets.filter((t) => t.order_id === o.id) })),
  };
}
export async function checkin(db: Pool, userId: string, code: unknown) {
  if (typeof code !== "string" || !/^[a-f0-9]{64}$/u.test(code))
    throw bad("That ticket was not found.", 404);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    // Cancellation locks orders before tickets; check-in uses the same order to avoid a race.
    const found = (
      await tx.query(
        `SELECT o.id AS order_id,t.id FROM event_tickets t JOIN event_orders o ON o.id=t.order_id WHERE t.code=$1`,
        [code],
      )
    ).rows[0];
    if (!found) throw bad("That ticket was not found.", 404);
    const order = (
      await tx.query("SELECT status FROM event_orders WHERE id=$1 FOR UPDATE", [found.order_id])
    ).rows[0];
    const ticket = (
      await tx.query(
        `SELECT t.*,e.title,tt.name AS type_name FROM event_tickets t JOIN event_orders o ON o.id=t.order_id JOIN ticket_types tt ON tt.id=o.type_id JOIN events e ON e.id=tt.event_id WHERE t.id=$1 FOR UPDATE OF t`,
        [found.id],
      )
    ).rows[0];
    if (order.status !== "paid" || ticket.cancelled_at)
      throw bad("This ticket was cancelled or is not valid.", 409);
    const entered = await tx.query(
      "INSERT INTO event_checkins(ticket_id,staff_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING checked_at",
      [ticket.id, userId],
    );
    if (!entered.rowCount) throw bad("This ticket has already been checked in.", 409);
    await tx.query("COMMIT");
    return { message: "Checked in", event: ticket.title, ticket: ticket.type_name };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function attendees(db: Pool, eventId: unknown) {
  return (
    await db.query(
      `SELECT o.id AS order_id,u.email,o.status,o.unit_cents,t.code,t.cancelled_at,c.checked_at,tt.name AS ticket_type FROM event_orders o JOIN app_users u ON u.id=o.user_id JOIN ticket_types tt ON tt.id=o.type_id LEFT JOIN event_tickets t ON t.order_id=o.id LEFT JOIN event_checkins c ON c.ticket_id=t.id WHERE tt.event_id=$1 ORDER BY o.created_at DESC LIMIT 10000`,
      [id(eventId)],
    )
  ).rows;
}
export async function exportAttendees(db: Pool, eventId: unknown) {
  const rows = await attendees(db, eventId);
  return csv([
    ["Email", "Ticket type", "Order status", "Ticket code", "Cancelled", "Checked in"],
    ...rows.map((r) => [
      r.email,
      r.ticket_type,
      r.status,
      r.code,
      r.cancelled_at?.toISOString(),
      r.checked_at?.toISOString(),
    ]),
  ]);
}
