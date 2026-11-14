/** Convert an event's wall clock into an instant; reject clocks skipped by daylight saving. */
export function localInstant(local: string, timezone: string) {
  const date = new Date(`${local}:00Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a date and time.");
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wall = (d: Date) => formatter.format(d).replace(" ", "T");
  const target = `${local}:00`;
  let result = date;
  for (let i = 0; i < 3; i++)
    result = new Date(result.getTime() + date.getTime() - new Date(`${wall(result)}Z`).getTime());
  if (wall(result) !== target)
    throw new Error(
      "That local time does not exist because the clocks change. Choose another time.",
    );
  return result.toISOString();
}
export function when(value: string, timezone: string) {
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value))} (${timezone})`;
}
