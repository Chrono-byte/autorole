import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DiscordAPIError,
  type Client,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { RoleService } from "./RoleService";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PENDING_RETRY_DELAY_MS = 5 * MINUTE_MS;

type Entry = {
  guildId: string;
  memberId: string;
  joinedAt: number;
  attempts: number;
  nextAttempt: number;
  screeningComplete: number;
};

export class OutstandingAssignments {
  private readonly db: Database;
  private readonly active = new Set<string>();
  private readonly changed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    path: string,
    private readonly client: Client,
    private readonly roles: RoleService,
    private readonly report: (error: unknown, guildId: string, memberId: string) => void,
    private readonly guildId?: string,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run(
      "CREATE TABLE IF NOT EXISTS assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, memberId))",
    );
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(assignments)").all();
    if (!columns.some((column) => column.name === "screeningComplete"))
      this.db.run(
        "ALTER TABLE assignments ADD COLUMN screeningComplete INTEGER NOT NULL DEFAULT 0",
      );
  }

  start() {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), MINUTE_MS);
    this.timer.unref();
  }

  observeJoin(member: GuildMember) {
    if (this.stopped || member.user.bot || (this.guildId && this.guildId !== member.guild.id))
      return;
    if (member.joinedTimestamp === null) {
      this.report(new Error("Join event has no join timestamp"), member.guild.id, member.id);
      return;
    }
    this.db.run(
      "INSERT INTO assignments (guildId, memberId, joinedAt, screeningComplete) VALUES (?, ?, ?, ?) ON CONFLICT (guildId, memberId) DO UPDATE SET joinedAt = excluded.joinedAt, screeningComplete = excluded.screeningComplete, attempts = 0, nextAttempt = 0",
      [member.guild.id, member.id, member.joinedTimestamp, member.pending === false ? 1 : 0],
    );
    this.observe(member);
  }

  observe(member: GuildMember | PartialGuildMember) {
    const entry = this.get(member.guild.id, member.id);
    if (!entry || this.stopped) return;
    if (member.pending === false && member.joinedTimestamp === entry.joinedAt) {
      this.db.run(
        "UPDATE assignments SET screeningComplete = 1 WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
        [entry.guildId, entry.memberId, entry.joinedAt],
      );
    }
    const key = `${entry.guildId}:${entry.memberId}`;
    if (this.active.has(key)) this.changed.add(key);
    else void this.process(entry);
  }

  async reconcile() {
    if (this.stopped) return;
    const entries = this.db
      .query<Entry, [number]>("SELECT * FROM assignments WHERE nextAttempt <= ?")
      .all(Date.now());
    for (const entry of entries) {
      if (this.stopped) break;
      await this.process(entry);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private get(guildId: string, memberId: string) {
    return this.db
      .query<Entry, [string, string]>(
        "SELECT * FROM assignments WHERE guildId = ? AND memberId = ?",
      )
      .get(guildId, memberId);
  }

  private async process(entry: Entry) {
    const key = `${entry.guildId}:${entry.memberId}`;
    if (this.stopped || this.active.has(key)) return;
    this.active.add(key);
    try {
      const guild = this.client.guilds.cache.get(entry.guildId);
      if (!guild || guild.available === false) throw new Error("Guild is unavailable");
      const member = await guild.members.fetch({ user: entry.memberId, force: true });
      if (this.stopped) return;
      if (member.joinedTimestamp !== entry.joinedAt) {
        this.remove(entry);
        return;
      }
      const latest = this.get(entry.guildId, entry.memberId);
      if (!latest || latest.joinedAt !== entry.joinedAt) return;
      const result = await this.roles.assign(member, latest.screeningComplete === 1);
      if (result === "complete") this.remove(entry);
      else this.defer(entry, result === "pending" ? PENDING_RETRY_DELAY_MS : undefined);
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof DiscordAPIError && error.code === 10007) this.remove(entry);
      else {
        this.report(error, entry.guildId, entry.memberId);
        this.defer(entry);
      }
    } finally {
      this.active.delete(key);
      if (this.changed.delete(key) && !this.stopped) {
        const latest = this.get(entry.guildId, entry.memberId);
        if (latest) void this.process(latest);
      }
    }
  }

  private remove(entry: Entry) {
    this.db.run("DELETE FROM assignments WHERE guildId = ? AND memberId = ? AND joinedAt = ?", [
      entry.guildId,
      entry.memberId,
      entry.joinedAt,
    ]);
  }

  private defer(
    entry: Entry,
    delay = Math.min(HOUR_MS, MINUTE_MS * 2 ** Math.min(entry.attempts, 6)),
  ) {
    this.db.run(
      "UPDATE assignments SET attempts = attempts + 1, nextAttempt = ? WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
      [Date.now() + delay, entry.guildId, entry.memberId, entry.joinedAt],
    );
  }
}
