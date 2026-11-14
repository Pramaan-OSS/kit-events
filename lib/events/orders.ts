import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Mailer } from "../email";
import type { pramaan } from "../pramaan";
import { bad, id, integer } from "./validation";

type Client = Pick<typeof pramaan, "call">;
export type Order = {
  id: string;
  user_id: string;
  type_id: string;
  quantity: number;
  unit_cents: number;
  currency: string;
  status: string;
  hold_until: Date;
  checkout_ref: string | null;
  checkout_url: string | null;
  email_status: string;
};
const PAYMENT_OFF = "Test payments are not switched on here. Free tickets are still available.";
async function issue(tx: PoolClient, order: Order) {
  for (let i = 0; i < order.quantity; i++)
    await tx.query("INSERT INTO event_tickets(id,order_id,code) VALUES($1,$2,$3)", [
      randomUUID(),
      order.id,
      randomBytes(32).toString("hex"),
    ]);
  await tx.query("UPDATE event_orders SET status='paid' WHERE id=$1", [order.id]);
}
/** Inventory changes always lock type, then order. No outside call holds a database lock. */
export function orders(
  db: Pool,
  client: Client,
  mailer: Mailer,
  verifiedEmail: (id: string) => Promise<string | null>,
) {
  async function reserve(userId: string, body: Record<string, unknown>) {
    const typeId = id(body.typeId),
      key = id(body.requestKey),
      quantity = integer(body.quantity, 1, 10, "a ticket quantity");
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const type = (
        await tx.query(
          `SELECT t.*,e.ends_at FROM ticket_types t JOIN events e ON e.id=t.event_id WHERE t.id=$1 FOR UPDATE OF t`,
          [typeId],
        )
      ).rows[0];
      if (!type) throw bad("That ticket type was not found.", 404);
      const old = (
        await tx.query<Order>("SELECT * FROM event_orders WHERE user_id=$1 AND request_key=$2", [
          userId,
          key,
        ])
      ).rows[0];
      if (old) {
        if (old.type_id !== typeId || old.quantity !== quantity)
          throw bad("Start a new checkout for different tickets.", 409);
        await tx.query("COMMIT");
        return old;
      }
      if (
        new Date(type.sales_start) > new Date() ||
        new Date(type.sales_end) <= new Date() ||
        new Date(type.ends_at) <= new Date()
      )
        throw bad("Ticket sales are closed.", 409);
      if (type.price_cents > 0 && process.env.PRAMAAN_PAYMENTS_MODE !== "test")
        throw bad(PAYMENT_OFF, 503);
      await tx.query(
        "UPDATE event_orders SET status='expired' WHERE type_id=$1 AND status='held' AND hold_until<=now()",
        [typeId],
      );
      const used = (
        await tx.query(
          "SELECT coalesce(sum(quantity),0)::int AS n FROM event_orders WHERE type_id=$1 AND status IN ('paid','held')",
          [typeId],
        )
      ).rows[0].n;
      if (used + quantity > type.capacity)
        throw bad("There are not enough tickets left. Choose fewer tickets.", 409);
      const order = (
        await tx.query<Order>(
          `INSERT INTO event_orders(id,user_id,type_id,quantity,unit_cents,currency,status,hold_until,request_key)
        VALUES($1,$2,$3,$4,$5,$6,'held',now()+interval '10 minutes',$7) RETURNING *`,
          [randomUUID(), userId, typeId, quantity, type.price_cents, type.currency, key],
        )
      ).rows[0];
      if (!order) throw bad("Order could not be created.", 503);
      if (type.price_cents === 0) {
        await issue(tx, order);
        order.status = "paid";
      }
      await tx.query("COMMIT");
      return order;
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally {
      tx.release();
    }
  }
  async function own(userId: string, orderId: unknown) {
    const r = (
      await db.query<Order>("SELECT * FROM event_orders WHERE id=$1 AND user_id=$2", [
        id(orderId),
        userId,
      ])
    ).rows[0];
    if (!r) throw bad("That order was not found.", 404);
    return r;
  }
  async function start(userId: string, body: Record<string, unknown>, origin: string) {
    const order = await reserve(userId, body);
    if (order.status === "paid") {
      await deliver(order.id);
      return { orderId: order.id };
    }
    if (order.status !== "held" || new Date(order.hold_until) <= new Date())
      throw bad("This hold ended. Start a new checkout.", 409);
    if (order.checkout_url) return { orderId: order.id, checkoutUrl: order.checkout_url };
    if (process.env.PRAMAAN_PAYMENTS_MODE !== "test") throw bad(PAYMENT_OFF, 503);
    const type = (await db.query("SELECT name FROM ticket_types WHERE id=$1", [order.type_id]))
      .rows[0];
    const back = `${origin}/tickets`;
    const answer = await client.call<{ ref?: unknown; checkoutUrl?: unknown }>(
      "payments.checkout.create",
      {
        lineItems: [
          {
            name: type.name,
            amount: order.unit_cents,
            currency: order.currency,
            quantity: order.quantity,
          },
        ],
        mode: "payment",
        successUrl: back,
        cancelUrl: back,
      },
      `events-checkout-${order.id}`,
    );
    if (!answer.ok) {
      // Unknown outcomes keep the hold and key. A retry uses the same order, never a second charge.
      throw bad(
        answer.off
          ? PAYMENT_OFF
          : "The payment page is unavailable. Retry this checkout before the hold ends.",
        503,
      );
    }
    const { ref, checkoutUrl } = answer.value;
    let safe = false;
    if (typeof checkoutUrl === "string") {
      try {
        const url = new URL(checkoutUrl);
        safe =
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
      } catch {}
    }
    if (typeof ref !== "string" || !ref || ref.length > 500 || !safe)
      throw bad("The payment page could not be opened. Retry this checkout.", 502);
    await db.query(
      "UPDATE event_orders SET checkout_ref=$2,checkout_url=$3 WHERE id=$1 AND checkout_ref IS NULL",
      [order.id, ref, checkoutUrl],
    );
    return { orderId: order.id, checkoutUrl };
  }
  async function confirm(order: Order) {
    if (!order.checkout_ref || order.status === "paid" || order.status === "refunded") return;
    const answer = await client.call<{
      status?: string;
      payments?: { status?: string; amount?: { amount?: number; currency?: string } }[];
    }>("payments.checkout.get", { ref: order.checkout_ref });
    if (!answer.ok || answer.value.status !== "paid" || !Array.isArray(answer.value.payments))
      return;
    const money = answer.value.payments
      .filter(
        (p) =>
          p.status === "captured" &&
          p.amount?.currency?.toLowerCase() === order.currency &&
          Number.isSafeInteger(p.amount?.amount) &&
          Number(p.amount?.amount) > 0,
      )
      .reduce((n, p) => n + Number(p.amount?.amount), 0);
    if (money !== order.quantity * order.unit_cents) return;
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM ticket_types WHERE id=$1 FOR UPDATE", [order.type_id]);
      const current = (
        await tx.query<Order>("SELECT * FROM event_orders WHERE id=$1 FOR UPDATE", [order.id])
      ).rows[0];
      if (!current) throw bad("Order not found.", 404);
      if (current.status === "paid" || current.status === "refunded") {
        await tx.query("COMMIT");
        return;
      }
      if (current.status === "held" && new Date(current.hold_until) > new Date())
        await issue(tx, current);
      else await tx.query("UPDATE event_orders SET status='review' WHERE id=$1", [order.id]);
      await tx.query("COMMIT");
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally {
      tx.release();
    }
  }
  async function deliver(orderId: string) {
    const order = (await db.query<Order>("SELECT * FROM event_orders WHERE id=$1", [orderId]))
      .rows[0];
    if (!order) return;
    if (order.status !== "paid" || order.email_status !== "not-sent") return;
    const to = await verifiedEmail(order.user_id);
    if (!to) return;
    const tickets = (
      await db.query(
        `SELECT t.code,e.title,e.venue,e.starts_at,e.timezone FROM event_tickets t JOIN event_orders o ON o.id=t.order_id JOIN ticket_types tt ON tt.id=o.type_id JOIN events e ON e.id=tt.event_id WHERE o.id=$1 AND t.cancelled_at IS NULL ORDER BY t.id`,
        [orderId],
      )
    ).rows;
    if (!tickets.length) return;
    const first = tickets[0];
    const result = await mailer.send(
      {
        to,
        subject: `Your tickets: ${first.title}`,
        text: `${first.title}\n${first.venue}\n${new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: first.timezone }).format(new Date(first.starts_at))} (${first.timezone})\n\nShow each code at the door:\n${tickets.map((t) => t.code).join("\n")}\n\nYou can also find your tickets by signing in.`,
      },
      `events-tickets-${orderId}`,
    );
    await db.query(
      "UPDATE event_orders SET email_status=$2 WHERE id=$1 AND email_status='not-sent'",
      [orderId, result.status],
    );
  }
  async function refresh(userId: string, orderId: unknown) {
    const order = await own(userId, orderId);
    await confirm(order);
    await deliver(order.id);
    return { checked: true };
  }
  async function release(
    orderId: unknown,
    userId: string,
    owner: boolean,
    refund: boolean,
    note: string,
  ) {
    const oid = id(orderId);
    const order = (
      await db.query<Order>(
        `SELECT * FROM event_orders WHERE id=$1 AND ($2::boolean OR user_id=$3)`,
        [oid, owner, userId],
      )
    ).rows[0];
    if (!order) throw bad("That order was not found.", 404);
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM ticket_types WHERE id=$1 FOR UPDATE", [order.type_id]);
      const current = (
        await tx.query<Order>("SELECT * FROM event_orders WHERE id=$1 FOR UPDATE", [oid])
      ).rows[0];
      if (!current) throw bad("Order not found.", 404);
      if (refund) {
        if (!owner) throw bad("Only the owner can record an outside refund.", 403);
        if (!["paid", "review"].includes(current.status) || current.unit_cents === 0)
          throw bad("This order does not need an outside refund.", 409);
        if (!note.trim())
          throw bad("Record a note confirming the refund completed outside this app.");
      } else if (current.unit_cents > 0 && ["paid", "review"].includes(current.status))
        throw bad("Paid orders need a completed outside refund recorded by the owner.", 409);
      if (["cancelled", "refunded"].includes(current.status))
        throw bad("This order was already released.", 409);
      await tx.query("UPDATE event_orders SET status=$2 WHERE id=$1", [
        oid,
        refund ? "refunded" : "cancelled",
      ]);
      await tx.query(
        "UPDATE event_tickets SET cancelled_at=now() WHERE order_id=$1 AND cancelled_at IS NULL",
        [oid],
      );
      if (refund)
        await tx.query(
          "INSERT INTO event_audit(id,order_id,owner_id,action,note) VALUES($1,$2,$3,'outside-refund',$4)",
          [randomUUID(), oid, userId, note.slice(0, 500)],
        );
      await tx.query("COMMIT");
      return { released: true };
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally {
      tx.release();
    }
  }
  return { reserve, start, own, confirm, deliver, refresh, release };
}
