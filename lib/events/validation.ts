import { AccountError } from "../accounts";
export const bad = (message: string, status = 400) => new AccountError(status, message);
export function text(value: unknown, label: string, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw bad(`Enter ${label}, up to ${max} characters.`);
  return value.trim();
}
export function id(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw bad("That record was not found.", 404);
  return value;
}
export function integer(value: unknown, min: number, max: number, label: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw bad(`Enter ${label} from ${min} to ${max}.`);
  return n;
}
export function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/(Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw bad("Enter a date with a time zone offset.");
  return new Date(value).toISOString();
}
export function zone(value: unknown) {
  const z = text(value, "a time zone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
  } catch {
    throw bad("Choose a valid event time zone.");
  }
  return z;
}
export function eventInput(b: Record<string, unknown>) {
  const start = instant(b.startsAt),
    end = instant(b.endsAt);
  if (start >= end) throw bad("The event must end after it starts.");
  return {
    title: text(b.title, "an event title"),
    venue: text(b.venue, "a venue", 200),
    category: id(b.categoryId),
    start,
    end,
    timezone: zone(b.timezone),
  };
}
