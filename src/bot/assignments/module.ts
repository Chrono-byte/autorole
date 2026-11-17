import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { event, type BotModule } from "@autorole/discord-framework";
import { type BotFeature, type BotOptions } from "../feature";
import { autoroleCommands } from "../commands/AutoroleCommands";
import { automaticRosterMember, refreshRoster, rosterChanged } from "../AutomaticRoster";
import { RoleService } from "../RoleService";
import { OutstandingAssignments } from "./OutstandingAssignments";

export const assignmentFeature = {
  definitions: autoroleCommands.definitions,
  make: Effect.fn("Assignments.module")(function* (client: Client, options: BotOptions) {
    const roles = new RoleService(options.guildId);
    const assignments = yield* OutstandingAssignments.make(
      options.path,
      client,
      roles,
      options.report,
      options.guildId,
    );
    return {
      commands: autoroleCommands.bind(roles),
      background: [
        {
          name: "role-assignments",
          interval: "1 minute",
          onFailure: "continue",
          run: () => assignments.reconcile(),
        },
        { name: "roster-sync", interval: "5 minutes", onFailure: "continue", run: refreshRoster },
      ],
      events: [
        event(Events.GuildMemberAdd, (member) => assignments.observeJoin(member)),
        event(Events.GuildMemberUpdate, (before, member) =>
          before.pending && !member.pending ? assignments.observe(member) : Effect.void,
        ),
        event(Events.GuildMemberUpdate, (before, member) =>
          rosterChanged(before, member) ? automaticRosterMember(member) : Effect.void,
        ),
        event(Events.GuildMemberAvailable, (member) => assignments.observe(member)),
      ],
    } satisfies BotModule;
  }),
} satisfies BotFeature;
