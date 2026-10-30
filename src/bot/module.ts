import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { event } from "@autorole/discord-framework";
import { makeCommandRegistry } from "./commands/AutoroleCommands";
import { OutstandingAssignments } from "./assignments/OutstandingAssignments";
import { RoleService } from "./RoleService";

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
  return {
    commands: makeCommandRegistry(roles),
    start: assignments.start(),
    events: [
      event(Events.GuildMemberAdd, (member) => assignments.observeJoin(member)),
      event(Events.GuildMemberUpdate, (before, member) =>
        before.pending && !member.pending ? assignments.observe(member) : Effect.void,
      ),
      event(Events.GuildMemberAvailable, (member) => assignments.observe(member)),
    ],
  };
});
