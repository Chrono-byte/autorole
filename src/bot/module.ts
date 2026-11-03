import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { buttonEvent, event, CommandRegistry } from "@autorole/discord-framework";
import { makeCommandRegistry } from "./commands/AutoroleCommands";
import { OutstandingAssignments } from "./assignments/OutstandingAssignments";
import { RoleService } from "./RoleService";
import { Suggestions } from "./suggestions/Suggestions";
import { StatsStore } from "./StatsStore";
import { automaticRosterMember, rosterChanged } from "./AutomaticRoster";
import { rosterGuildId } from "./commands/syncRoster";
import { AgreementStore } from "./guidelines/AgreementStore";
import {
  guidelinesButton,
  guidelinesCommands,
  isGuidelinesButton,
} from "./guidelines/GuidelinesCommand";
import { serverStatsCommands } from "./commands/ServerStatsCommand";

export const makeAutorole = Effect.fn("Autorole.make")(function* (
  client: Client,
  options: {
    path: string;
    guildId?: string;
    report: (error: unknown, guildId: string, memberId: string) => Effect.Effect<void>;
  },
) {
  const roles = new RoleService(options.guildId);
  const assignments = yield* OutstandingAssignments.make(
    options.path,
    client,
    roles,
    options.report,
    options.guildId,
  );
  const suggestions = yield* Suggestions.make(
    client,
    options.path === ":memory:" ? ":memory:" : `${options.path}.suggestions`,
  );
  const stats = yield* StatsStore.make(
    options.path === ":memory:" ? ":memory:" : `${options.path}.stats`,
  );
  const agreements = yield* AgreementStore.make(
    options.path === ":memory:" ? ":memory:" : `${options.path}.guidelines`,
  );
  yield* agreements.deactivate(rosterGuildId);
  return {
    stats,
    commands: CommandRegistry.combine([
      makeCommandRegistry(roles),
      serverStatsCommands(stats),
      guidelinesCommands(agreements),
    ]),
    start: assignments.start(),
    teamGate: Effect.void,
    events: [
      buttonEvent(isGuidelinesButton, (interaction) => guidelinesButton(agreements, interaction)),
      buttonEvent(
        (interaction) => interaction.customId.startsWith("suggestions:"),
        (interaction) => suggestions.interaction(interaction),
      ),
      event(Events.MessageCreate, (message) => suggestions.message(message)),
      event(Events.MessageUpdate, (_before, message) => suggestions.edited(message)),
      event(Events.GuildMemberAdd, (member) => assignments.observeJoin(member)),
      event(Events.GuildMemberUpdate, (before, member) =>
        Effect.gen(function* () {
          if (before.pending && !member.pending) yield* assignments.observe(member);
          if (rosterChanged(before, member)) yield* automaticRosterMember(member);
        }),
      ),
      event(Events.GuildMemberAvailable, (member) => assignments.observe(member)),
    ],
  };
});
