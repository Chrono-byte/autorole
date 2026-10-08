import { AutoroleBot } from "./bot/AutoroleBot";
import { readConfiguration } from "./config/Configuration";
const bot = new AutoroleBot(readConfiguration());
process.once("SIGINT", () => {
  void bot.stop().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void bot.stop().then(() => process.exit(0));
});
await bot.start();
