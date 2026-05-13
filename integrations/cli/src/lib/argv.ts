/**
 * Minimal argv parser. No external dependency — keeps the install footprint tiny.
 *
 * Recognized forms:
 *   --flag                  → flags.flag = true
 *   --key=value             → flags.key = "value"
 *   --key value             → flags.key = "value"  (when value does not start with '-')
 *   positional arguments    → positional[]
 *
 * The first positional is treated as the subcommand by `parseCommandLine`.
 */

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set<string>([
  'workspace',
  'port',
  'token',
  'model',
  'component',
  'node',
  'name',
  'description',
  'description-file',
  'from-dir',
  'source-dir',
]);

export function parseCommandLine(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx >= 0) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    // Single-dash short flag (e.g. -h, -v). Always boolean; never consumes a value.
    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }

    positional.push(arg);
  }

  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}
