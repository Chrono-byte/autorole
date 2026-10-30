import { expect, test } from "bun:test";
import { exponentialBackoff } from "@autorole/jobs";

test("exponential backoff doubles from the base and stays capped", () => {
  expect(exponentialBackoff(0, 60_000, 3_600_000)).toBe(60_000);
  expect(exponentialBackoff(3, 60_000, 3_600_000)).toBe(480_000);
  expect(exponentialBackoff(6, 60_000, 3_600_000)).toBe(3_600_000);
  expect(exponentialBackoff(10_000, 60_000, 3_600_000)).toBe(3_600_000);
});

test("backoff rejects invalid inputs and accepts zero and fractional delays", () => {
  for (const attempts of [-1, 0.5, NaN, Infinity])
    expect(() => exponentialBackoff(attempts, 1, 10)).toThrow(RangeError);
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    expect(() => exponentialBackoff(0, value, 10)).toThrow(RangeError);
    expect(() => exponentialBackoff(0, 1, value)).toThrow(RangeError);
  }
  expect(exponentialBackoff(2, 0.5, 3)).toBe(2);
  expect(exponentialBackoff(10000, 0, 0)).toBe(0);
});
