/** Calculate a capped exponential delay. Attempts MUST be a nonnegative finite integer; base and cap MUST be nonnegative finite numbers. Invalid inputs throw RangeError. */
export function exponentialBackoff(attempts: number, base: number, cap: number) {
  if (!Number.isInteger(attempts) || attempts < 0)
    throw new RangeError("attempts must be a nonnegative finite integer");
  if (!Number.isFinite(base) || base < 0 || !Number.isFinite(cap) || cap < 0)
    throw new RangeError("base and cap must be nonnegative finite numbers");
  return Math.min(cap, base * 2 ** Math.min(attempts, 1023));
}
