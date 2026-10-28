import { Effect } from "effect";
import { runCommand } from "../runCommand";

function sendNotification() {
  return runCommand("systemd-notify", ["--ready", "--status=Connected to Discord"], {
    timeout: 10000,
  }).pipe(Effect.asVoid);
}

export function notifyReady(
  socket = process.env.NOTIFY_SOCKET,
  notify = sendNotification,
): Effect.Effect<void, Error> {
  return socket ? notify() : Effect.void;
}
