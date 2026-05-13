/**
 * Tiny ANSI color helpers. No external dependency.
 *
 * Color is suppressed when:
 *   - The output stream is not a TTY.
 *   - `NO_COLOR` is set in the environment (https://no-color.org/).
 *   - `--no-color` flag is passed on the command line.
 *
 * Pass an explicit `enabled` boolean to override the auto-detect (tests).
 */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

export interface ColorOptions {
  enabled?: boolean;
  stream?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: Record<string, string | undefined>;
  flags?: Record<string, string | boolean>;
}

export function shouldUseColor(opts: ColorOptions = {}): boolean {
  if (opts.enabled !== undefined) return opts.enabled;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return false;
  const flags = opts.flags ?? {};
  if (flags['no-color'] === true) return false;
  const stream = opts.stream ?? process.stdout;
  return Boolean(stream.isTTY);
}

export interface Colorize {
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

export function makeColorize(enabled: boolean): Colorize {
  if (!enabled) {
    return {
      green: (s) => s,
      red: (s) => s,
      yellow: (s) => s,
      cyan: (s) => s,
      bold: (s) => s,
      dim: (s) => s,
    };
  }
  return {
    green: (s) => `${CODES.green}${s}${CODES.reset}`,
    red: (s) => `${CODES.red}${s}${CODES.reset}`,
    yellow: (s) => `${CODES.yellow}${s}${CODES.reset}`,
    cyan: (s) => `${CODES.cyan}${s}${CODES.reset}`,
    bold: (s) => `${CODES.bold}${s}${CODES.reset}`,
    dim: (s) => `${CODES.dim}${s}${CODES.reset}`,
  };
}
