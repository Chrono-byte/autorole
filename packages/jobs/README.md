# Jobs

A Bun SQLite job store and an in-process, per-key coordinator. Jobs have a key, generation, JSON payload, attempt count, and next-attempt timestamp. Replacing a job resets its retry state; updates, deferrals, and removals require the matching generation so stale attempts cannot change a replacement.

The worker owns polling and per-key coordination. The caller owns retry policy, payload validation, and job execution. The coordinator coalesces observations during an attempt into a follow-up check. It does not coordinate across processes: run only one bot instance per database. SQLite persistence does not make external side effects exactly once; handlers must tolerate retries.

The assignment adapter migrates the old `assignments` table to `jobs` in a transaction. This is a one-way schema migration: an older bot version will not read the migrated jobs. Back up the state database before deployment if rollback is needed.
