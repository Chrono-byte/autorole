import { AutoroleBot } from "./bot/AutoroleBot";
import { Configuration } from "./config/Configuration";
const bot = new AutoroleBot(new Configuration());
process.once("SIGINT", () => {
  void bot.stop().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void bot.stop().then(() => process.exit(0));
});
await bot.start();
