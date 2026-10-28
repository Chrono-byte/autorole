import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tryPromise } from "./effectful";

const exec = promisify(execFile);

export function runCommand(file: string, args: string[], options: { timeout?: number } = {}) {
  return tryPromise((signal) => exec(file, args, { ...options, signal }));
}
