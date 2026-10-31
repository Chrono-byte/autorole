import {
  ApplicationFlagsBitField,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
} from "discord.js";
import { Effect, Schema } from "effect";
import { discordRequest } from "@autorole/discord-framework";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { trySync } from "../effectful";
import { ConfigurationError } from "../errors";
import { runMain } from "../runMain";
import { privateSuggestionOverwrites } from "../bot/suggestions/privacy";
import {
  suggestionGuildId,
  suggestionInboxChannelId,
  suggestionOpenId,
  suggestionPanel,
  suggestionPanelChannelId,
} from "../bot/suggestions/Suggestions";

const overwrite = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  allow: Schema.String,
  deny: Schema.String,
});
const channel = Schema.Struct({
  id: Schema.String,
  guild_id: Schema.String,
  type: Schema.Number,
  parent_id: Schema.NullOr(Schema.String),
  permission_overwrites: Schema.Array(overwrite),
});
const application = Schema.Struct({ id: Schema.String, flags: Schema.Number });
const role = Schema.Struct({ id: Schema.String, permissions: Schema.String });
const message = Schema.Struct({
  id: Schema.String,
  author: Schema.Struct({ id: Schema.String }),
  components: Schema.optional(
    Schema.Array(
      Schema.Struct({
        components: Schema.optional(
          Schema.Array(Schema.Struct({ custom_id: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});
const parseChannel = Schema.decodeUnknownEffect(channel);
const parseApplication = Schema.decodeUnknownEffect(application);
const parseRoles = Schema.decodeUnknownEffect(Schema.Array(role));
const parseMessages = Schema.decodeUnknownEffect(Schema.Array(message));
const officerCategoryId = "1566109875535355994";

export const setupSuggestions = Effect.fn("Suggestions.setup")(function* (
  config: Configuration,
  rest: REST,
  options: { checkOnly?: boolean } = {},
) {
  if (config.applicationId !== "1551628047323762811")
    return yield* new ConfigurationError({
      message: "Use Sigil's application ID to set up suggestions.",
    });
  const app = yield* discordRequest(() => rest.get(Routes.oauth2CurrentApplication())).pipe(
    Effect.flatMap(parseApplication),
  );
  if (app.id !== config.applicationId)
    return yield* new ConfigurationError({
      message: "The token does not belong to the configured application.",
    });
  const flags = new ApplicationFlagsBitField(app.flags);
  if (
    !flags.has(ApplicationFlagsBitField.Flags.GatewayMessageContent) &&
    !flags.has(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited)
  )
    return yield* new ConfigurationError({
      message: "Enable Message Content Intent for Sigil before setting up suggestions.",
    });
  const inbox = yield* discordRequest(() =>
    rest.get(Routes.channel(suggestionInboxChannelId)),
  ).pipe(Effect.flatMap(parseChannel));
  const parent = yield* discordRequest(() => rest.get(Routes.channel(officerCategoryId))).pipe(
    Effect.flatMap(parseChannel),
  );
  const panelChannel = yield* discordRequest(() =>
    rest.get(Routes.channel(suggestionPanelChannelId)),
  ).pipe(Effect.flatMap(parseChannel));
  const roles = yield* discordRequest(() => rest.get(Routes.guildRoles(suggestionGuildId))).pipe(
    Effect.flatMap(parseRoles),
  );
  const everyoneRole = roles.find((item) => item.id === suggestionGuildId);
  const officerRole = roles.find((item) => item.id === "1564387083642998897");
  const validPrivacy = (c: typeof inbox) =>
    privateSuggestionOverwrites(
      c.permission_overwrites.map((o) => ({ ...o, allow: BigInt(o.allow), deny: BigInt(o.deny) })),
    );
  if (
    inbox.guild_id !== suggestionGuildId ||
    inbox.type !== ChannelType.GuildText ||
    inbox.parent_id !== officerCategoryId ||
    parent.guild_id !== suggestionGuildId ||
    parent.type !== ChannelType.GuildCategory ||
    panelChannel.guild_id !== suggestionGuildId ||
    panelChannel.type !== ChannelType.GuildText ||
    !everyoneRole ||
    !officerRole ||
    (BigInt(everyoneRole.permissions) & PermissionFlagsBits.Administrator) !== 0n ||
    !validPrivacy(inbox) ||
    !validPrivacy(parent)
  )
    return yield* new ConfigurationError({
      message: "The suggestions inbox or channel permissions are not configured safely.",
    });

  let officerPermissions = BigInt(everyoneRole.permissions) | BigInt(officerRole.permissions);
  if ((officerPermissions & PermissionFlagsBits.Administrator) === 0n) {
    for (const id of [suggestionGuildId, officerRole.id]) {
      const entry = inbox.permission_overwrites.find((item) => item.id === id && item.type === 0);
      if (entry)
        officerPermissions = (officerPermissions & ~BigInt(entry.deny)) | BigInt(entry.allow);
    }
  }
  if (
    !new PermissionsBitField(officerPermissions).has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessagesInThreads,
    ])
  )
    return yield* new ConfigurationError({
      message: "Officers need access to the suggestion inbox and its threads.",
    });

  const blocked =
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.CreatePublicThreads |
    PermissionFlagsBits.CreatePrivateThreads |
    PermissionFlagsBits.SendMessagesInThreads;
  const trustedPosters = new Set([
    suggestionGuildId,
    "1557133002285387857",
    "1564387083642998897",
    "1415400507006124101",
    "1565937863802228818",
  ]);
  if (
    panelChannel.permission_overwrites.some(
      (o) => (BigInt(o.allow) & blocked) !== 0n && (o.type !== 0 || !trustedPosters.has(o.id)),
    )
  )
    return yield* new ConfigurationError({
      message: "An untrusted channel overwrite allows public suggestions; review it before setup.",
    });

  const panels: string[] = [];
  let before: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
    const page = yield* discordRequest(() =>
      rest.get(Routes.channelMessages(suggestionPanelChannelId), { query }),
    ).pipe(Effect.flatMap(parseMessages));
    for (const item of page) {
      if (
        item.author.id === app.id &&
        item.components?.some((row) =>
          row.components?.some((button) => button.custom_id === suggestionOpenId),
        )
      )
        panels.push(item.id);
    }
    if (page.length < 100) break;
    const next = page.at(-1)?.id;
    if (!next || next === before)
      return yield* new ConfigurationError({
        message: "Could not inspect the complete suggestions channel history.",
      });
    before = next;
  }
  if (panels.length > 1)
    return yield* new ConfigurationError({
      message: "Multiple suggestion panels exist; remove duplicates before setup.",
    });
  if (options.checkOnly) return;
  const body = {
    content: suggestionPanel.content,
    components: suggestionPanel.components.map((row) => row.toJSON()),
    allowed_mentions: { parse: [] },
  };
  const existing = panels[0];
  if (existing)
    yield* discordRequest(() =>
      rest.patch(Routes.channelMessage(suggestionPanelChannelId, existing), { body }),
    );
  else
    yield* discordRequest(() =>
      rest.post(Routes.channelMessages(suggestionPanelChannelId), { body }),
    );

  const prior = panelChannel.permission_overwrites.find(
    (o) => o.id === suggestionGuildId && o.type === 0,
  );
  const allow = BigInt(prior?.allow ?? "0") & ~blocked;
  const deny = BigInt(prior?.deny ?? "0") | blocked;
  yield* discordRequest(() =>
    rest.put(Routes.channelPermission(suggestionPanelChannelId, suggestionGuildId), {
      body: { type: 0, allow: allow.toString(), deny: deny.toString() },
      reason: "Use private suggestion conversations",
    }),
  );
  const verified = yield* discordRequest(() =>
    rest.get(Routes.channel(suggestionPanelChannelId)),
  ).pipe(Effect.flatMap(parseChannel));
  const updated = verified.permission_overwrites.find(
    (o) => o.id === suggestionGuildId && o.type === 0,
  );
  if (!updated || BigInt(updated.allow) !== allow || BigInt(updated.deny) !== deny)
    return yield* new ConfigurationError({
      message: "Could not verify suggestions channel permissions.",
    });
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const config = yield* readConfiguration();
    const rest = yield* trySync(() => new REST({ version: "10" }).setToken(config.token));
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      return yield* new ConfigurationError({
        message: "Usage: bun run setup:suggestions [--check]",
      });
    const checkOnly = args[0] === "--check";
    yield* setupSuggestions(config, rest, { checkOnly });
    yield* Effect.sync(() =>
      process.stdout.write(
        checkOnly
          ? "Suggestions setup checks passed.\n"
          : "Suggestion panel is installed; members can use the button to DM officers.\n",
      ),
    );
  });
  await runMain(program, "suggestions_setup_failed");
}
