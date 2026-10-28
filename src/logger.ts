import { Context, Effect, Logger, Option, Tracer } from "effect";

type LogField = string | number | boolean | null | undefined;
type LogFields = Record<string, LogField>;
const priorities = { All: 7, Trace: 7, Debug: 7, Info: 6, Warn: 4, Error: 3, Fatal: 2, None: 6 };

export const journalLogger = Logger.make((options) => {
  const entry = Logger.formatStructured.log(options);
  const span = Context.getOption(options.fiber.context, Tracer.ParentSpan);
  const fields = {
    ...entry.annotations,
    fiberId: entry.fiberId,
    traceId: Option.isSome(span) ? span.value.traceId : undefined,
    spanId: Option.isSome(span) ? span.value.spanId : undefined,
    spans: Object.keys(entry.spans).length > 0 ? entry.spans : undefined,
    cause: entry.cause,
  };
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const event = String(entry.message).replaceAll("\n", "\\n");
  const line = `<${priorities[options.logLevel]}>${event}${details ? ` ${details}` : ""}\n`;
  if (options.logLevel === "Error" || options.logLevel === "Fatal") process.stderr.write(line);
  else process.stdout.write(line);
});

export const journalLoggerLayer = Logger.layer([journalLogger, Logger.tracerLogger]);

export function logError(event: string, fields: LogFields) {
  return Effect.logError(event).pipe(Effect.annotateLogs(fields));
}

export function logInfo(event: string, fields: LogFields) {
  return Effect.logInfo(event).pipe(Effect.annotateLogs(fields));
}
