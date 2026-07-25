import http from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptedTurn =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; argsJson: string; id?: string }
  | { type: "error"; status: number };

export interface FakeProvider {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

/**
 * A minimal OpenAI-compatible streaming chat/completions endpoint, standing
 * in for a real LLM provider. Each request consumes the next scripted turn
 * (in call order) and streams back just enough of the wire format for
 * ProviderClient.chatOnce() to parse -- role/content/tool_calls deltas
 * followed by a final chunk carrying usage, then "[DONE]".
 */
export function startFakeProvider(script: ScriptedTurn[]): Promise<FakeProvider> {
  let next = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    req.resume(); // drain the request body; we don't need it
    req.on("end", () => {
      requests++;
      const turn = script[next++];
      if (!turn) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: `no more scripted turns (request #${next})` } })
        );
        return;
      }
      if (turn.type === "error") {
        res.writeHead(turn.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted provider failure" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const base = {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fake-model",
      };
      const write = (
        delta: Record<string, unknown>,
        finish: string | null,
        usage?: Record<string, unknown>
      ) => {
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`
        );
      };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (turn.type === "text") {
        write({ role: "assistant" }, null);
        write({ content: turn.text }, null);
        write({}, "stop", usage);
      } else {
        write(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: turn.id ?? "call_1",
                type: "function",
                function: { name: turn.name, arguments: "" },
              },
            ],
          },
          null
        );
        write({ tool_calls: [{ index: 0, function: { arguments: turn.argsJson } }] }, null);
        write({}, "tool_calls", usage);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A provider that never responds -- for exercising --timeout's real abort path. */
export function startHangingProvider(): Promise<FakeProvider> {
  let requests = 0;
  const server = http.createServer((req) => {
    req.resume();
    requests++;
    // never respond
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
