import { describe, expect, it } from "vitest";
import { csv, parseCsv } from "./csv";
import { localInstant } from "./time";

describe("CSV and time zones", () => {
  it("reads quoted commas, newlines and escaped quotes", () => {
    expect(parseCsv('a,b\r\n"one, two","say ""hello""\nagain"')).toEqual([
      ["a", "b"],
      ["one, two", 'say "hello"\nagain'],
    ]);
  });
  it("rejects broken quotes", () => {
    expect(() => parseCsv('"open')).toThrow();
    expect(() => parseCsv('"closed"extra')).toThrow();
  });
  it("defuses formulas", () => {
    expect(csv([["=1+1", " a,b", '"quote"']])).toBe('"\'=1+1"," a,b","""quote"""');
  });
  it("uses the event time zone and rejects a skipped clock time", () => {
    expect(localInstant("2027-06-15T18:00", "Europe/London")).toBe("2027-06-15T17:00:00.000Z");
    expect(() => localInstant("2027-03-28T01:30", "Europe/London")).toThrow("does not exist");
  });
});
