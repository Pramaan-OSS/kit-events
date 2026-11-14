"use client";
import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { localInstant, when } from "../lib/events/time";
import { api, useResource } from "../lib/pramaan/client";
import type { User } from "./shell";

type Category = { id: string; name: string };
type TicketType = {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  available: number;
  sales_start: string;
  sales_end: string;
};
type Event = {
  id: string;
  title: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  category: string;
  category_id: string;
  types: TicketType[];
};
type Catalog = { events: Event[]; categories: Category[] };
const post = <T,>(action: string, body: unknown) =>
  api<T>(`/api/events/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
export function Frame({
  title,
  children,
  kicker = "Gather",
}: {
  title: string;
  children: ReactNode;
  kicker?: string;
}) {
  return (
    <main className="workspace">
      <p className="eyebrow">{kicker}</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
export function EventList({ selected }: { selected?: string }) {
  const r = useResource<Catalog>("/api/events/catalog");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState<{ typeId: string; quantity: number; requestKey: string }>();
  async function buy(e: FormEvent<HTMLFormElement>, typeId: string) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const quantity = Number(new FormData(e.currentTarget).get("quantity"));
    const body =
      retry?.typeId === typeId && retry.quantity === quantity
        ? retry
        : { typeId, quantity, requestKey: crypto.randomUUID() };
    setRetry(body);
    try {
      const result = await post<{ checkoutUrl?: string; orderId: string }>("checkout", body);
      setRetry(undefined);
      location.assign(result.checkoutUrl ?? "/tickets");
    } catch (error) {
      setMessage((error as Error).message);
      r.reload();
    } finally {
      setBusy(false);
    }
  }
  const items = r.data?.events.filter((e) => !selected || e.id === selected);
  return (
    <Frame
      title={selected ? (items?.[0]?.title ?? "Event") : "Make room for something good."}
      kicker="Meet · learn · celebrate"
    >
      <p className="lede">
        Find your next gathering. Reserve a place, keep your ticket, and we'll see you at the door.
      </p>
      <p className="notice">
        Paid checkout runs in test mode. Seats are held for ten minutes while you pay.
      </p>
      {r.error && <p role="alert">Events could not load. Please try again.</p>}
      {r.loading && <p>Loading events…</p>}
      {items?.length === 0 && (
        <section>
          <h2>{selected ? "Event not found" : "The next gathering is on its way"}</h2>
          <p>
            {selected
              ? "Choose an event from the list."
              : "New events will appear here when the organiser adds them."}
          </p>
        </section>
      )}
      <div className="event-grid">
        {items?.map((event) => (
          <article key={event.id} className="event-card">
            <div className="event-art" aria-hidden="true">
              <span>
                {new Intl.DateTimeFormat("en-GB", {
                  month: "short",
                  day: "numeric",
                  timeZone: event.timezone,
                }).format(new Date(event.starts_at))}
              </span>
              <b>↗</b>
            </div>
            <div className="card-body">
              <p className="eyebrow">{event.category}</p>
              <h2>
                <Link href={`/event/${event.id}`}>{event.title}</Link>
              </h2>
              <p>{event.venue}</p>
              <p className="muted">
                {when(event.starts_at, event.timezone)}
                <br />
                Ends {when(event.ends_at, event.timezone)}
              </p>
              {event.types.length === 0 && <p>Tickets are not on sale yet.</p>}
              {event.types.map((t) => (
                <form key={t.id} onSubmit={(e) => void buy(e, t.id)} className="ticket-choice">
                  <h3>
                    {t.name}{" "}
                    <span>{t.price_cents ? money(t.price_cents, t.currency) : "Free"}</span>
                  </h3>
                  <p>
                    {t.available} places left · Sales close {when(t.sales_end, event.timezone)}
                  </p>
                  <label>
                    Quantity
                    <input
                      name="quantity"
                      type="number"
                      min="1"
                      max={Math.min(10, t.available)}
                      defaultValue="1"
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={
                      busy ||
                      !t.available ||
                      new Date(t.sales_start) > new Date() ||
                      new Date(t.sales_end) <= new Date()
                    }
                  >
                    {t.available ? "Get tickets" : "Sold out"}
                  </button>
                  <p className="muted">
                    <Link href="/signin">Sign in or create an attendee account</Link> before
                    checkout.
                  </p>
                </form>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p role="status">{message}</p>
    </Frame>
  );
}
export function Signin() {
  const [signup, setSignup] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Frame title={signup ? "Your next event starts here" : "Welcome back"}>
      <section className="narrow">
        <h2>{signup ? "Create attendee account" : "Sign in"}</h2>
        <p>Organisers and door staff use the sign-in details set by the owner.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              await api(`/api/account/${signup ? "signup" : "signin"}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
              });
              location.assign("/");
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              minLength={signup ? 12 : 1}
              autoComplete={signup ? "new-password" : "current-password"}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {signup ? "Create account" : "Sign in"}
          </button>
        </form>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setSignup(!signup);
            setMessage("");
          }}
        >
          {signup ? "Already have an account? Sign in" : "New here? Create attendee account"}
        </button>
        <p>
          <Link href="/password-reset">Forgot password?</Link>
        </p>
        <p role="status">{message}</p>
      </section>
    </Frame>
  );
}
type Ticket = { id: string; code: string; cancelled_at: string | null; checked_at: string | null };
type Order = {
  id: string;
  title: string;
  venue: string;
  starts_at: string;
  timezone: string;
  type_name: string;
  quantity: number;
  unit_cents: number;
  currency: string;
  status: string;
  email_status: string;
  hold_until: string;
  tickets: Ticket[];
};
export function MyTickets() {
  const r = useResource<{ orders: Order[] }>("/api/events/tickets");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ orders: Order[] }>("/api/events/tickets")
      .then(async (data) => {
        for (const order of data.orders.filter((o) =>
          ["held", "expired", "cancelled", "paid"].includes(o.status),
        )) {
          if (!active) return;
          await post("refresh", { orderId: order.id });
        }
        if (active) r.reload();
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [r.reload]);
  async function act(action: string, orderId?: string) {
    setBusy(true);
    try {
      if (action === "verify") {
        const a = await api<{ message?: string }>("/api/account/verify-email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        setMessage(
          a.message ??
            "Check your email for a confirmation link. If email is off, delivery is unavailable.",
        );
      } else {
        await post(action, { orderId });
        setMessage("Updated.");
      }
      r.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame title="Your tickets">
      <p>
        Confirm your email to receive ticket codes. Your tickets are always available here after
        payment.
      </p>
      <button type="button" disabled={busy} onClick={() => void act("verify")}>
        Send email confirmation
      </button>
      {r.error && (
        <p role="alert">
          {r.error.message} <Link href="/signin">Sign in</Link>
        </p>
      )}
      {r.data?.orders.length === 0 && (
        <section>
          <h2>No tickets yet</h2>
          <Link href="/">Explore events</Link>
        </section>
      )}
      {r.data?.orders.map((o) => (
        <section key={o.id}>
          <p className="eyebrow">
            {o.status === "review" ? "Payment needs organiser review" : o.status}
          </p>
          <h2>{o.title}</h2>
          <p>
            {o.venue} · {when(o.starts_at, o.timezone)}
          </p>
          <p>
            {o.quantity} × {o.type_name} · {money(o.quantity * o.unit_cents, o.currency)}
          </p>
          {o.status === "held" && (
            <p>
              Hold ends {new Date(o.hold_until).toLocaleTimeString()}. If it expires, start a new
              checkout from the event.
            </p>
          )}
          {o.status === "review" && (
            <p>
              Your payment arrived after the hold ended. No tickets were issued. Contact the
              organiser for an outside refund.
            </p>
          )}
          {o.tickets.map((t) => (
            <div className="ticket" key={t.id}>
              <b>
                {t.cancelled_at ? "Cancelled" : t.checked_at ? "Checked in" : "Ready for the door"}
              </b>
              <p>Ticket code</p>
              <code>{t.code}</code>
            </div>
          ))}
          {o.status === "paid" && (
            <p>
              Ticket email:{" "}
              {o.email_status === "sent"
                ? "sent"
                : o.email_status === "unknown"
                  ? "delivery could not be confirmed"
                  : "not sent — confirm your email; email must be switched on"}
            </p>
          )}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void act("refresh", o.id)}>
              Check payment & email
            </button>
            {["held", "expired"].includes(o.status) ||
            (o.status === "paid" && o.unit_cents === 0) ? (
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void act("cancel", o.id)}
              >
                Cancel order & release seats
              </button>
            ) : null}
          </div>
        </section>
      ))}
      <p role="status">{message}</p>
    </Frame>
  );
}
export function Door() {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const r = useResource<{ user: User }>("/api/account/session");
  if (!r.data || !["owner", "door"].includes(r.data.user.role))
    return (
      <Frame title="Door check-in">
        <p>
          {r.loading ? "Checking access…" : "Sign in as door staff or the owner to check tickets."}
        </p>
        <Link href="/signin">Sign in</Link>
      </Frame>
    );
  return (
    <Frame title="A warm welcome, one ticket at a time." kicker="Door check-in">
      <section className="narrow">
        <h2>Check a ticket</h2>
        <p>Paste the attendee's ticket code. Each ticket can be used once.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              const r = await post<{ message: string; event: string; ticket: string }>("checkin", {
                code: String(f.get("code")).trim(),
              });
              setMessage(`${r.message} · ${r.event} · ${r.ticket}`);
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Ticket code
            <input name="code" required autoComplete="off" maxLength={64} />
          </label>
          <button type="submit" disabled={busy}>
            Check in
          </button>
        </form>
        <p role="status" className="notice">
          {message}
        </p>
      </section>
    </Frame>
  );
}
function Select({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: { id: string; name: string }[];
}) {
  return (
    <label>
      {label}
      <select name={name} aria-label={label} required>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Input({
  label,
  name,
  type = "text",
  value,
}: {
  label: string;
  name: string;
  type?: string;
  value?: string;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value} required />
    </label>
  );
}
export function Organiser() {
  const r = useResource<Catalog>("/api/events/catalog"),
    u = useResource<{ user: User }>("/api/account/session"),
    staff = useResource<{ staff: { email: string }[] }>("/api/events/staff");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [eventId, setEventId] = useState("");
  const people = useResource<{
    attendees: {
      order_id: string;
      unit_cents: number;
      code: string | null;
      email: string;
      status: string;
      ticket_type: string;
      checked_at: string | null;
    }[];
  }>(eventId ? `/api/events/attendees?event=${eventId}` : "/api/events/attendees");
  async function submit(e: FormEvent<HTMLFormElement>, action: string) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const f = new FormData(e.currentTarget),
      body: Record<string, unknown> = { action, ...Object.fromEntries(f.entries()) };
    try {
      if (action === "event") {
        body.startsAt = localInstant(String(body.startsAt), String(body.timezone));
        body.endsAt = localInstant(String(body.endsAt), String(body.timezone));
      }
      if (action === "type") {
        const zone = r.data?.events.find((e) => e.id === body.eventId)?.timezone ?? "UTC";
        body.salesStart = localInstant(String(body.salesStart), zone);
        body.salesEnd = localInstant(String(body.salesEnd), zone);
        body.priceCents = Math.round(Number(body.price) * 100);
      }
      await post("manage", body);
      setMessage("Saved.");
      r.reload();
      staff.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (u.data?.user.role !== "owner")
    return (
      <Frame title="Organiser">
        <p>
          {u.loading
            ? "Checking access…"
            : "This page is for the owner. Open as owner from Pramaan."}
        </p>
      </Frame>
    );
  const events = r.data?.events ?? [],
    categories = r.data?.categories ?? [];
  return (
    <Frame title="Bring your next event to life." kicker="Organiser">
      <p className="lede">Set the date, open the doors, and let people find their place.</p>
      <p role="status" className="notice">
        {message}
      </p>
      <div className="manage-grid">
        <section>
          <h2>New event</h2>
          <form onSubmit={(e) => void submit(e, "event")}>
            <Input label="Event title" name="title" />
            <Input label="Venue" name="venue" />
            <Select label="Category" name="categoryId" options={categories} />
            <Input label="Event time zone" name="timezone" value="Europe/London" />
            <Input label="Starts (event local time)" name="startsAt" type="datetime-local" />
            <Input label="Ends (event local time)" name="endsAt" type="datetime-local" />
            <button type="submit" disabled={busy}>
              Create event
            </button>
          </form>
        </section>
        <section>
          <h2>Ticket types</h2>
          <form onSubmit={(e) => void submit(e, "type")}>
            <Select
              label="Event"
              name="eventId"
              options={events.map((e) => ({ id: e.id, name: e.title }))}
            />
            <Input label="Ticket name" name="name" value="General admission" />
            <label>
              Price per ticket
              <input name="price" type="number" min="0" step="0.01" defaultValue="0" required />
            </label>
            <label>
              Currency
              <select name="currency" aria-label="Currency">
                <option value="gbp">GBP</option>
                <option value="usd">USD</option>
                <option value="eur">EUR</option>
                <option value="inr">INR</option>
              </select>
            </label>
            <Input label="Capacity" name="capacity" type="number" value="50" />
            <Input label="Sales start (event local time)" name="salesStart" type="datetime-local" />
            <Input label="Sales end (event local time)" name="salesEnd" type="datetime-local" />
            <button type="submit" disabled={busy}>
              Add ticket type
            </button>
          </form>
        </section>
        <section>
          <h2>Event categories</h2>
          <form onSubmit={(e) => void submit(e, "category")}>
            <Input label="New category" name="name" />
            <button type="submit" disabled={busy}>
              Add category
            </button>
          </form>
          {categories.map((c) => (
            <form className="inline-form" key={c.id} onSubmit={(e) => void submit(e, "category")}>
              <input type="hidden" name="id" value={c.id} />
              <label>
                Category name
                <input
                  name="name"
                  aria-label={`Category name ${c.name}`}
                  defaultValue={c.name}
                  key={c.name}
                  required
                />
              </label>
              <button disabled={busy} type="submit" aria-label={`Rename ${c.name}`}>
                Rename
              </button>
              <button
                disabled={busy}
                className="quiet"
                aria-label={`Remove ${c.name}`}
                type="button"
                onClick={async () => {
                  try {
                    await post("manage", { action: "remove-category", id: c.id });
                    setMessage("Category removed.");
                    r.reload();
                  } catch (e) {
                    setMessage((e as Error).message);
                  }
                }}
              >
                Remove
              </button>
            </form>
          ))}
          <p>Categories used by an event cannot be removed.</p>
        </section>
        <section>
          <h2>Door staff</h2>
          <p>
            Share these sign-in details privately with your staff member. Door staff can only check
            tickets in.
          </p>
          <form onSubmit={(e) => void submit(e, "staff")}>
            <Input label="Staff email" name="email" type="email" />
            <Input label="Staff password (12+ characters)" name="password" type="password" />
            <button type="submit" disabled={busy}>
              Add door staff
            </button>
          </form>
          {staff.data?.staff.map((s) => (
            <p key={s.email}>{s.email}</p>
          ))}
        </section>
      </div>
      <section>
        <h2>Import events</h2>
        <p>
          Up to 100 events per file. Dates include an offset; category names must match an existing
          category. Import creates events; add ticket types above.
        </p>
        <p>
          <a href="/events-example.csv" download>
            Download example CSV
          </a>
        </p>
        <form onSubmit={(e) => void submit(e, "import")}>
          <label>
            CSV content
            <textarea
              name="csv"
              rows={6}
              required
              placeholder="title,venue,category,startsAt,endsAt,timezone"
            />
          </label>
          <label>
            Load a CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 12000) {
                  setMessage("Import at most 12 KB at a time.");
                  return;
                }
                const area = e.target.form?.elements.namedItem("csv") as HTMLTextAreaElement;
                area.value = await f.text();
              }}
            />
          </label>
          <button type="submit" disabled={busy}>
            Import events
          </button>
        </form>
      </section>
      <section>
        <h2>Attendees & orders</h2>
        <label>
          Attendees for event
          <select
            aria-label="Attendees for event"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
          >
            <option value="">Choose an event…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </label>
        {eventId && (
          <>
            <p>
              <a href={`/api/events/export?event=${eventId}`} download>
                Export attendees CSV
              </a>
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attendee</th>
                    <th>Ticket</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {people.data?.attendees.map((p) => (
                    <tr key={p.code ?? p.order_id}>
                      <td>{p.email}</td>
                      <td>{p.ticket_type}</td>
                      <td>{p.checked_at ? "Checked in" : p.status}</td>
                      <td>
                        {["paid", "review"].includes(p.status) && p.unit_cents > 0 ? (
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              try {
                                await post("outside-refund", {
                                  orderId: p.order_id,
                                  note: f.get("note"),
                                });
                                setMessage("Outside refund recorded. Seats released.");
                                people.reload();
                                r.reload();
                              } catch (e) {
                                setMessage((e as Error).message);
                              }
                            }}
                          >
                            <label>
                              Completed outside refund note
                              <input name="note" required maxLength={500} />
                            </label>
                            <button type="submit">Record completed outside refund</button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await post("cancel", { orderId: p.order_id });
                                people.reload();
                                r.reload();
                              } catch (e) {
                                setMessage((e as Error).message);
                              }
                            }}
                          >
                            Cancel & release
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p>
          Refund payments are not available here. Complete a paid refund outside this app before
          recording it. Free orders can be cancelled by their attendee.
        </p>
      </section>
    </Frame>
  );
}
