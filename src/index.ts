import { Effect } from "effect";
import { runAutorole } from "./bot/AutoroleBot";
import { readConfiguration } from "./config/Configuration";
import { runMain } from "./runMain";

const program = Effect.gen(function* () {
  const configuration = yield* readConfiguration();
  yield* runAutorole(configuration);
});

await runMain(program, "autorole_start_failed");
