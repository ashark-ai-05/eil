import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptHidden } from "../prompt.js";

describe("promptHidden", () => {
  it("never echoes typed characters, even across line edits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.on("data", (c) => {
      captured += c.toString();
    });

    const p = promptHidden("jira token", input, output);

    // type "abcZ", backspace (drop Z -> "abc"), left-arrow (cursor before "c"),
    // type "Q" -> "abQc", then submit.
    for (const ch of "abcZ") input.write(ch);
    input.write("\x7f"); // backspace
    input.write("\x1b[D"); // left arrow
    input.write("Q");
    input.write("\r"); // enter

    const answer = await p;

    // Strip the one-time label ("jira token: ") before checking — the label
    // itself is not a secret and happens to share letters (e.g. "a") with the
    // secret alphabet we're asserting against.
    const afterLabel = captured.slice(captured.indexOf(": ") + 2);
    for (const secretChar of ["a", "b", "c", "Z", "Q"]) {
      expect(afterLabel).not.toContain(secretChar);
    }
    expect(answer).toBe("abQc");
  });
});
