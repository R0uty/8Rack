import type { Response } from "express";
import { RequestCancelledError } from "../services/errors.js";
import type { ChatResponseChunk } from "../types/ollama.js";

/** Wires up an AbortController that fires when the client disconnects mid-stream. */
export function abortOnClientDisconnect(res: Response): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

/**
 * Writes an async generator of chat chunks to `res` as newline-delimited JSON, matching Ollama's
 * own streaming format. Shared by every route that streams a chat completion (POST /api/chat,
 * POST /api/agents/:id/chat) so the write/error-handling logic isn't duplicated between them.
 */
export async function pipeNdjsonStream(
  res: Response,
  stream: AsyncGenerator<ChatResponseChunk>,
  next: (err: unknown) => void,
): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    for await (const chunk of stream) {
      res.write(`${JSON.stringify(chunk)}\n`);
    }
    res.end();
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      res.end();
      return;
    }
    if (!res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`${JSON.stringify({ error: message })}\n`);
    res.end();
  }
}
