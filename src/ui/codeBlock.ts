/**
 * Pulls the last fenced code block out of agent output, so one keystroke can
 * copy it to the clipboard.
 *
 * The agent writes fenced blocks (` ```ts … ``` `) constantly and copying one
 * by hand means selecting across a wrapped, scrollable transcript — fiddly at
 * best and wrong at worst. This finds the last complete block and returns just
 * its body, with the language tag kept separately for the caller's message.
 *
 * Only *complete* blocks count: an unterminated fence (output still streaming)
 * would otherwise hand back a half-written snippet. The fence parsing mirrors
 * Markdown.tsx (`line.trimStart().startsWith("```")`), including the rule that
 * the info string is whatever follows the three backticks.
 */

export interface CodeBlock {
  /** The block's contents, without the fence lines. */
  code: string;
  /** The info string after the opening fence (e.g. "ts", "bash"), if any. */
  lang: string;
}

/**
 * The last complete fenced block in `text`, or null when there is none.
 *
 * A block with no closing fence is ignored, not returned partially — that is
 * what makes this safe to call while output is still arriving.
 */
export function extractLastCodeBlock(text: string): CodeBlock | null {
  const lines = text.split("\n");
  let inCode = false;
  let lang = "";
  let current: string[] = [];
  let last: CodeBlock | null = null;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        // Closing fence: the block is complete, so it becomes the latest
        // candidate. A later block simply overwrites it.
        last = { code: current.join("\n"), lang };
        current = [];
        lang = "";
        inCode = false;
      } else {
        lang = line.trim().slice(3).trim().toLowerCase();
        inCode = true;
      }
      continue;
    }
    if (inCode) current.push(line);
  }

  // A trailing opener that never closed leaves `inCode` true with `last` still
  // holding the previous complete block — which is the one to return.
  return last;
}
