import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function sendNotification() {
  await exec("systemd-notify", ["--ready", "--status=Connected to Discord"], { timeout: 10000 });
}

export async function notifyReady(socket = process.env.NOTIFY_SOCKET, notify = sendNotification) {
  if (socket) await notify();
}
