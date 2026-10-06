import { DiscordAPIError, HTTPError, type GuildMember } from "discord.js";
import { setTimeout as delay } from "node:timers/promises";
import { RoleService } from "./RoleService";

export class AssignmentQueue {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly roles: Pick<RoleService, "assign">,
    private readonly report: (
      error: unknown,
      member: GuildMember,
      attempt: number,
      retrying: boolean,
    ) => void,
    private readonly retryDelays = [2000, 10000, 30000],
  ) {}

  enqueue(member: GuildMember) {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    const key = `${member.guild.id}:${member.id}`;
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const job = this.run(member).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }

  stop() {
    this.shutdown.abort();
  }

  private async run(member: GuildMember) {
    for (let attempt = 0; !this.shutdown.signal.aborted; attempt++) {
      try {
        const current =
          attempt === 0
            ? member
            : await member.guild.members.fetch({ user: member.id, force: true });
        if (this.shutdown.signal.aborted) return;
        await this.roles.assign(current);
        return;
      } catch (error) {
        if (this.shutdown.signal.aborted) return;
        // A member who left no longer needs an assignment.
        if (error instanceof DiscordAPIError && error.code === 10007) return;
        const wait = this.retryDelays[attempt];
        const retrying = wait !== undefined && AssignmentQueue.isTransient(error);
        this.report(error, member, attempt + 1, retrying);
        if (!retrying || wait === undefined) return;
        try {
          await delay(wait, undefined, { signal: this.shutdown.signal });
        } catch {
          return;
        }
      }
    }
  }

  private static isTransient(error: unknown): boolean {
    if (error instanceof DiscordAPIError || error instanceof HTTPError)
      return error.status >= 500 && error.status < 600;
    if (!(error instanceof Error)) return false;
    if (error.name === "TimeoutError") return true;
    if (
      "code" in error &&
      typeof error.code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EPIPE",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(error.code)
    )
      return true;
    return error.cause instanceof Error && AssignmentQueue.isTransient(error.cause);
  }
}
