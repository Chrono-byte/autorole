import { Effect } from "effect";
import { AutoroleBot } from "./bot/AutoroleBot";
import { readConfiguration } from "./config/Configuration";
import { runMain } from "./runMain";

const program = Effect.gen(function* () {
  const configuration = yield* readConfiguration();
  yield* new AutoroleBot(configuration).run();
});

await runMain(program, "autorole_start_failed");
