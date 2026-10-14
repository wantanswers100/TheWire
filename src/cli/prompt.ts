// The one interactive prompt for the whole CLI. Replaces the
// `(Bun.stdin as unknown as { read… }).read(buf)` casts: `Bun.stdin.read`
// does not exist in Bun 1.3.14 and the cast hid that from tsc (QA T1,
// 2026-09-30). Uses node:readline/promises, as codex-cmd.ts already does.
// Refuses (false/null) whenever it cannot get a real answer: no TTY,
// EOF, or a closed stream. A prompt must never approve by default.

import { createInterface } from "node:readline/promises";

export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

function defaultIO(): PromptIO {
  return { input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY) };
}

export async function promptLine(question: string, io: PromptIO = defaultIO()): Promise<string | null> {
  if (!io.isTTY) {
    io.output.write(`${question}\n(non-interactive context — cannot prompt, refusing)\n`);
    return null;
  }
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(question).then((a) => resolve(a), () => resolve(null));
    });
    return answer === null ? null : answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptYesNo(question: string, io?: PromptIO): Promise<boolean> {
  const answer = await promptLine(`${question} [y/N] `, io);
  return answer !== null && /^(y|yes)$/i.test(answer);
}
