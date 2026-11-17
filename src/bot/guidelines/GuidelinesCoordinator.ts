import { type Client, type Guild, type GuildMember } from "discord.js";
import { Effect, Semaphore } from "effect";
import { discordRequest } from "@autorole/discord-framework";
import { type AgreementStore } from "./AgreementStore";
import { agreementButton } from "./AgreementPanel";
import {
  applyTeamGate,
  applyMemberAccess,
  guidelinesChannelId,
  resolveTeamRoles,
  validateTeamGate,
  type TeamRoles,
} from "./TeamGate";
import { guildId as overwatchGuildId } from "../../config/discord";

export class GuidelinesCoordinator {
  private readonly accessLock = Semaphore.makeUnsafe(1);
  private readonly renewalLock = Semaphore.makeUnsafe(1);

  readonly agreements: Pick<
    AgreementStore,
    "active" | "history" | "getAcceptance" | "acceptCurrent"
  >;

  constructor(private readonly store: AgreementStore) {
    this.agreements = store;
  }

  renew = Effect.fn("Guidelines.renew")(
    function* (
      this: GuidelinesCoordinator,
      guild: Guild,
      period: { id: string; period: string; version: string; messageId: string; startedAt: number },
    ) {
      if (!period.period || !period.version || !/^\d{17,20}$/.test(period.messageId))
        return yield* Effect.fail(
          new Error("Provide a semester, document version, and valid message ID."),
        );
      const mapping = yield* resolveTeamRoles(guild);
      yield* validateTeamGate(guild, mapping);
      const channel = yield* discordRequest(() => guild.channels.fetch(guidelinesChannelId));
      if (!channel?.isTextBased() || !("messages" in channel))
        return yield* Effect.fail(new Error("The team-guidelines channel is unavailable."));
      const message = yield* discordRequest(() => channel.messages.fetch(period.messageId));
      if (
        message.author.id !== guild.client.user?.id ||
        (!message.content.trim() && message.embeds.length === 0)
      )
        return yield* Effect.fail(
          new Error("Choose a message containing the approved guidelines posted by this bot."),
        );
      yield* discordRequest(() => message.edit({ components: [agreementButton(period.id)] }));
      yield* this.accessLock.withPermit(
        this.store.startPeriod({ ...period, guildId: guild.id, channelId: channel.id }),
      );
    },
    (effect) => this.renewalLock.withPermit(effect),
  );

  reconcile(guild: Guild, configured?: TeamRoles) {
    return this.accessLock.withPermit(applyTeamGate(guild, this.store, configured));
  }

  reconcileMember(member: GuildMember) {
    return this.accessLock.withPermit(applyMemberAccess(member, this.store));
  }

  grantCurrent(...args: Parameters<AgreementStore["grantCurrent"]>) {
    return this.accessLock.withPermit(this.store.grantCurrent(...args));
  }

  deactivate(guildId: string) {
    return this.accessLock.withPermit(this.store.deactivate(guildId));
  }

  refresh = Effect.fn("Guidelines.refresh")(function* (
    this: GuidelinesCoordinator,
    client: Client,
  ) {
    const guild = client.guilds.cache.get(overwatchGuildId);
    if (!guild) return;
    const result = yield* this.reconcile(guild);
    if (result.failed.length)
      return yield* Effect.fail(
        new Error(
          `Team access synchronization incomplete: ${result.failed.length} member updates failed (${result.failed.join(", ")}).`,
        ),
      );
  });
}
