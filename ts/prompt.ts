/** Interactive-prompt helpers for the CLI, kept separate from cli.ts so they
 * can be unit-tested without executing `program.parseAsync`. */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Read a line from `input` WITHOUT echoing it (for secrets). Prints `label`
 * once, then unconditionally suppresses all readline echo for the duration of
 * the question, so no keystroke — including line edits (backspace/arrow) — can
 * leak the typed value to `output`. Fully hidden, like `sudo`.
 */
export function promptHidden(
  label: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    output.write(`${label}: `);
    const rl = createInterface({ input, output, terminal: true });
    (rl as any)._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer.trim());
    });
  });
}
