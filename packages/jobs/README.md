# Jobs

A Bun SQLite job store and an in-process, per-key coordinator. Jobs have a key, generation, JSON payload, attempt count, and next-attempt timestamp. Replacing a job resets its retry state; updates, deferrals, and removals require the matching generation so stale attempts cannot change a replacement.

The worker owns polling, per-key coordination, and applying attempt outcomes. An attempt returns `complete` to remove a job, `retry` with a delay in milliseconds to defer it, or `skip` to leave it untouched. The caller owns retry policy, payload validation, and job execution. Completion and deferral callbacks must use the attempted job’s generation so stale outcomes cannot modify a replacement. The coordinator coalesces observations during an attempt into a follow-up check. It does not coordinate across processes: run only one bot instance per database. SQLite persistence does not make external side effects exactly once; handlers must tolerate retries.

The bot uses the `jobs` schema. Older bot versions do not read it, so rolling back requires reconciling the database as well as restoring the executable. If an old `assignments` table exists, the bot refuses to start rather than silently ignore outstanding assignments.
