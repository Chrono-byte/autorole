import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { buttonEvent, event } from "@autorole/discord-framework";
import { commandCatalog } from "./commands";
import { OutstandingAssignments } from "./assignments/OutstandingAssignments";
import { serverMemberCounter } from "./member-counter/ServerStats";
import { RoleService } from "./RoleService";
import { Suggestions } from "./suggestions/Suggestions";
import { StatsStore } from "./member-counter/StatsStore";
import { automaticRoster, automaticRosterMember, rosterChanged } from "./AutomaticRoster";
import { automaticTeamGate, reconcileMemberAccess, teamDefinitions } from "./guidelines/TeamGate";
import { AgreementStore } from "./guidelines/AgreementStore";
import { guidelinesButton, isGuidelinesButton } from "./guidelines/GuidelinesCommand";

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
  return {
    commands: commandCatalog.bind({ roles, stats, agreements }),
    background: [
      () => assignments.start(),
      automaticRoster,
      (readyClient: Client<true>) => automaticTeamGate(readyClient, agreements),
      (readyClient: Client<true>) => serverMemberCounter(readyClient, stats),
    ],
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
          if (
            teamDefinitions.some((team) =>
              team.identity.some((id) => before.roles.cache.has(id) !== member.roles.cache.has(id)),
            )
          )
            yield* reconcileMemberAccess(member, agreements);
        }),
      ),
      event(Events.GuildMemberAvailable, (member) => assignments.observe(member)),
    ],
  };
});
