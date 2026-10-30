import { type ChatInputCommandInteraction } from "discord.js";
import { Effect } from "effect";
import { checkPermissions, type CommandPermissions } from "./permissions";

export type CommandDefinition = { name: string; toJSON: () => { name: string } };
export type Command = {
  definition: CommandDefinition;
  run: (interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>;
  permissions?: CommandPermissions;
};

export type CommandSpec<Context> = {
  definition: CommandDefinition;
  run: (context: Context, interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>;
  permissions?: CommandPermissions;
};

/** Keep command metadata available before runtime dependencies are constructed. */
export class CommandCatalog<Context> {
  constructor(private readonly commands: readonly CommandSpec<Context>[]) {
    const names = new Set<string>();
    for (const command of commands) {
      const name = command.definition.name;
      if (names.has(name)) throw new Error(`Duplicate command: ${name}`);
      names.add(name);
    }
  }

  get definitions() {
    return this.commands.map(({ definition }) => definition);
  }

  bind(context: Context) {
    return new CommandRegistry(
      this.commands.map(({ definition, run, permissions }) => ({
        definition,
        permissions,
        run: (interaction) => run(context, interaction),
      })),
    );
  }
}

/** A command's definition is shared by dispatch and Discord registration. */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  static combine(registries: readonly CommandRegistry[]) {
    return new CommandRegistry(registries.flatMap((registry) => [...registry.commands.values()]));
  }

  constructor(commands: readonly Command[]) {
    for (const command of commands) {
      const name = command.definition.name;
      if (this.commands.has(name)) throw new Error(`Duplicate command: ${name}`);
      this.commands.set(name, command);
    }
  }

  get definitions() {
    return Array.from(this.commands.values(), ({ definition }) => definition);
  }

  dispatch(interaction: ChatInputCommandInteraction) {
    const command = this.commands.get(interaction.commandName);
    if (!command) return Effect.void;
    const check = command.permissions
      ? checkPermissions(interaction, command.permissions)
      : Effect.void;
    return check.pipe(
      Effect.andThen(
        Effect.try({
          try: () => command.run(interaction),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(Effect.flatMap((handler) => handler)),
      ),
    );
  }
}
