/**
 * Pure command-routing helpers shared by the executable entrypoint and tests.
 */

const COMMAND_PREFIX_FLAGS = new Set(["-y", "--auto-approve", "--no-auto-approve", "--dangerous"]);
const SERVICE_COMMANDS = new Set(["start", "stop", "restart", "status"]);

export type ServiceCommand = "start" | "stop" | "restart" | "status";

/**
 * Return the first non-flag argument while preserving aliases such as `-y web`.
 */
export function getFirstPositionalArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/**
 * Detect every spelling that should open the local Web configuration UI.
 */
export function isWebConfigCommand(args: string[]): boolean {
  const firstPositional = getFirstPositionalArg(args);
  if (isTopLevelAlias(args, "web")) return true;
  if (firstPositional !== "config") return false;

  const configArgIndex = args.indexOf("config");
  return args.includes("--web") || args[configArgIndex + 1] === "web";
}

export function getServiceCommand(args: string[]): ServiceCommand | undefined {
  for (const command of SERVICE_COMMANDS) {
    if (isTopLevelAlias(args, command)) return command as ServiceCommand;
  }

  return undefined;
}

export function isServiceCommand(args: string[]): boolean {
  return getServiceCommand(args) !== undefined;
}

/**
 * Match a top-level command alias while rejecting option values such as --model web.
 */
function isTopLevelAlias(args: string[], command: string): boolean {
  const commandIndex = args.indexOf(command);
  if (commandIndex < 0) return false;
  return args.slice(0, commandIndex).every((arg) => COMMAND_PREFIX_FLAGS.has(arg));
}
