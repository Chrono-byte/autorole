import { type ChatInputCommandInteraction } from "discord.js";
import { Effect, Schema } from "effect";
import { checkPermissions, type CommandPermissions } from "./permissions";

export type SubcommandRoute<Context> = {
  name: string;
  group?: string;
  permissions?: CommandPermissions;
  run: (context: Context, interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>;
};

export class UnknownSubcommandError extends Schema.TaggedError<UnknownSubcommandError>()(
  "UnknownSubcommandError",
  {
    command: Schema.String,
    group: Schema.NullOr(Schema.String),
    subcommand: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

/** Route a command's subcommands, optionally within named subcommand groups. */
export function subcommands<Context>(routes: readonly SubcommandRoute<Context>[]) {
  const handlers = new Map<string, SubcommandRoute<Context>>();
  for (const route of routes) {
    const key = JSON.stringify([route.group ?? null, route.name]);
    if (handlers.has(key))
      throw new Error(
        `Duplicate subcommand route: ${[route.group, route.name].filter(Boolean).join(" ")}`,
      );
    handlers.set(key, route);
  }
  return Effect.fn("Discord.subcommands")(function* (
    context: Context,
    interaction: ChatInputCommandInteraction,
  ) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const route = handlers.get(JSON.stringify([group, subcommand]));
    if (!route)
      return yield* new UnknownSubcommandError({
        command: interaction.commandName,
        group,
        subcommand,
        message: `Unknown subcommand route for /${interaction.commandName}${group ? ` ${group}` : ""}${subcommand ? ` ${subcommand}` : ""}`,
      });
    if (route.permissions) yield* checkPermissions(interaction, route.permissions);
    yield* route.run(context, interaction);
  });
}
