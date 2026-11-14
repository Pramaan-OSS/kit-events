import { bad } from "./validation";
/** RFC 4180 fields, including quotes, commas and newlines. Reject malformed rows atomically. */
export function parseCsv(source: string): string[][] {
  if (Buffer.byteLength(source) > 12000) throw bad("Import at most 12 KB at a time.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
      continue;
    }
    if (c === '"') {
      if (cell || closed) throw bad("Check the CSV quotes.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && source[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw bad("Check the CSV quotes.");
      cell += c;
    }
  }
  if (quoted) throw bad("Close the CSV quote.");
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length > 101) throw bad("Import at most 100 events at a time.");
  return rows;
}
export function csv(rows: unknown[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let s = String(value ?? "");
          if (/^[\s]*[=+@-]/u.test(s) || /^[\t\r\n]/u.test(s)) s = `'${s}`;
          return `"${s.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
