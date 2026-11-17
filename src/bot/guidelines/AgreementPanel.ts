import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export const agreementPrefix = "guidelines:agree:";

export function agreementButton(periodId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${agreementPrefix}${periodId}`)
      .setLabel("Agree to the Code of Conduct")
      .setStyle(ButtonStyle.Primary),
  );
}
