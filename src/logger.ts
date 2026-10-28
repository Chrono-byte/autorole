type LogField = string | number | boolean | null | undefined;
type LogFields = Record<string, LogField>;

const PRIORITY = { error: 3, info: 6 } as const;

function writeLog(level: keyof typeof PRIORITY, event: string, fields: LogFields) {
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const line = `<${PRIORITY[level]}>${event}${details ? ` ${details}` : ""}\n`;
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

export function logError(event: string, fields: LogFields): Effect.Effect<void> {
  return Effect.sync(() => writeLog("error", event, fields));
}

export function logInfo(event: string, fields: LogFields): Effect.Effect<void> {
  return Effect.sync(() => writeLog("info", event, fields));
}
import { Effect } from "effect";
