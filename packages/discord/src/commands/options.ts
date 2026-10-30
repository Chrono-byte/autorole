import { type ChatInputCommandInteraction, type CacheType, type ChannelType } from "discord.js";
import { Effect } from "effect";

function read<A>(run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

/** Read slash-command options with discord.js's required/optional semantics in the Effect error channel. */
export function options<Cached extends CacheType>(
  resolver: ChatInputCommandInteraction<Cached>["options"],
) {
  return {
    required: {
      string: (name: string) => read(() => resolver.getString(name, true)),
      integer: (name: string) => read(() => resolver.getInteger(name, true)),
      number: (name: string) => read(() => resolver.getNumber(name, true)),
      boolean: (name: string) => read(() => resolver.getBoolean(name, true)),
      user: (name: string) => read(() => resolver.getUser(name, true)),
      role: (name: string) => read(() => resolver.getRole(name, true)),
      channel: <const Type extends ChannelType = ChannelType>(
        name: string,
        channelTypes?: readonly Type[],
      ) => read(() => resolver.getChannel(name, true, channelTypes)),
      mentionable: (name: string) => read(() => resolver.getMentionable(name, true)),
      attachment: (name: string) => read(() => resolver.getAttachment(name, true)),
    },
    optional: {
      string: (name: string) => read(() => resolver.getString(name)),
      integer: (name: string) => read(() => resolver.getInteger(name)),
      number: (name: string) => read(() => resolver.getNumber(name)),
      boolean: (name: string) => read(() => resolver.getBoolean(name)),
      user: (name: string) => read(() => resolver.getUser(name)),
      member: (name: string) => read(() => resolver.getMember(name)),
      role: (name: string) => read(() => resolver.getRole(name)),
      channel: <const Type extends ChannelType = ChannelType>(
        name: string,
        channelTypes?: readonly Type[],
      ) => read(() => resolver.getChannel(name, false, channelTypes)),
      mentionable: (name: string) => read(() => resolver.getMentionable(name)),
      attachment: (name: string) => read(() => resolver.getAttachment(name)),
    },
  };
}
