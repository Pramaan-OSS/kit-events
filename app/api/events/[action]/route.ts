import { emailDoor } from "../../../../lib/email";
import {
  attendees,
  catalog,
  checkin,
  exportAttendees,
  manage,
  tickets,
} from "../../../../lib/events/data";
import { orders } from "../../../../lib/events/orders";
import { bad, text } from "../../../../lib/events/validation";
import { pramaan } from "../../../../lib/pramaan";
import { handle, readBody, reply } from "../../../../lib/roles/http";
import { accountRuntime, database } from "../../../../lib/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
async function route(request: Request, context: Context) {
  return handle(async () => {
    const { action } = await context.params,
      db = database(),
      accounts = accountRuntime();
    if (request.method === "GET" && action === "catalog") return reply(await catalog(db));
    const user = await accounts.requireUser(request);
    const service = orders(db, pramaan, emailDoor, accounts.verifiedEmail);
    if (request.method === "GET") {
      if (action === "tickets") {
        if (user.role !== "member") throw bad("This page is for attendees.", 403);
        return reply(await tickets(db, user.id));
      }
      if (action === "staff") {
        await accounts.requireRole(request, ["owner"]);
        return reply({
          staff: (await db.query("SELECT email FROM app_users WHERE role='door' ORDER BY email"))
            .rows,
        });
      }
      if (action === "attendees" || action === "export") {
        await accounts.requireRole(request, ["owner"]);
        const eid = new URL(request.url).searchParams.get("event");
        if (action === "attendees") return reply({ attendees: await attendees(db, eid) });
        return new Response(await exportAttendees(db, eid), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="attendees.csv"',
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }
    if (request.method !== "POST") throw bad("That page was not found.", 404);
    const body = await readBody(request);
    if (action === "manage") {
      await accounts.requireRole(request, ["owner"]);
      return reply(await manage(db, body));
    }
    if (action === "checkin") {
      await accounts.requireRole(request, ["owner", "door"]);
      return reply(await checkin(db, user.id, body.code));
    }
    if (action === "checkout" || action === "refresh") {
      await accounts.requireRole(request, ["member"]);
      if (action === "refresh") return reply(await service.refresh(user.id, body.orderId));
      // Only the configured app origin can be used for payment returns.
      return reply(
        await service.start(user.id, body, process.env.APP_ORIGIN ?? new URL(request.url).origin),
      );
    }
    if (action === "cancel") {
      await accounts.requireRole(request, ["owner", "member"]);
      return reply(await service.release(body.orderId, user.id, user.role === "owner", false, ""));
    }
    if (action === "outside-refund") {
      await accounts.requireRole(request, ["owner"]);
      return reply(
        await service.release(
          body.orderId,
          user.id,
          true,
          true,
          text(body.note, "a refund confirmation note", 500),
        ),
      );
    }
    throw bad("That action was not found.", 404);
  });
}

export { route as GET, route as POST };
