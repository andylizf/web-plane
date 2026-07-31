/**
 * Command-line shape, with no I/O — so it can be tested without a browser.
 *
 * The rules here are load-bearing rather than cosmetic: `-s` picks which
 * *browser* a destructive command acts on, and the same flag has to be found
 * whether it was written `-s=name` or `-s name`, and whether it came before or
 * after the command word. Reading it wrong does not fail — it silently acts on
 * somebody else's session.
 */

/**
 * Flags that take no value.
 *
 * Without a full flag table there is no way to know whether the bare word after
 * a flag is that flag's value or the command — and most flags reaching this
 * parser belong to playwright-cli, which is free to add value-taking ones. So
 * the default stays "the next word is a value" and only the switches web-plane
 * itself documents are listed here. `--headed` is the one that mattered:
 * `web-plane --headed open <url>` read `open` as its value and then proxied
 * `https://…` to playwright-cli as if it were a command.
 */
const NO_VALUE_FLAGS = new Set(['--headed', '--isolated', '--help', '-h', '--version', '-v']);

/**
 * Split an argv tail into the command word and the args on each side of it.
 *
 * The command is the first bare word, but a flag's *value* is also a bare word,
 * so `-s deep status` has to skip `deep` to reach `status`.
 */
export function parseInvocation(rawArgs) {
  let commandIndex = -1;
  let command = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('-')) {
      // `-s=deep` carries its value; `-s deep` does not, so the next token is
      // the value and must not be mistaken for the command.
      if (
        !arg.includes('=') &&
        !NO_VALUE_FLAGS.has(arg) &&
        i + 1 < rawArgs.length &&
        !rawArgs[i + 1].startsWith('-')
      ) {
        i++;
      }
      continue;
    }
    command = arg;
    commandIndex = i;
    break;
  }
  return {
    command,
    commandIndex,
    globalArgs: commandIndex > 0 ? rawArgs.slice(0, commandIndex) : [],
    commandArgs: commandIndex >= 0 ? rawArgs.slice(commandIndex + 1) : [],
  };
}

/**
 * The session name, from anywhere in argv.
 *
 * Scanning the whole argv (not just the part before the command) is deliberate:
 * `web-plane cdp -s=work` reads the same as `web-plane -s=work cdp`, and a
 * parser that only looked at global flags would quietly fall back to the
 * `default` session for one of them.
 */
export function parseSessionFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-s=')) return args[i].slice(3);
    if (args[i] === '-s' && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

/** `--as <lane>` / `--as=<lane>`, and everything that wasn't it. */
export function parseLaneFlag(commandArgs) {
  let lane = null;
  const rest = [];
  for (let i = 0; i < commandArgs.length; i++) {
    const a = commandArgs[i];
    if (a.startsWith('--as=')) lane = a.slice(5);
    else if (a === '--as' && commandArgs[i + 1]) lane = commandArgs[++i];
    else rest.push(a);
  }
  return { lane, rest };
}
