export class ApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function throwForErrorResponse(res: Response): Promise<never> {
  let message =
    res.status >= 500
      ? "Could not reach the backend server. Is it running?"
      : `Request failed with status ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    code = body?.code;
  } catch {
    // response body wasn't JSON (e.g. a dev-server proxy error page); keep the fallback message
  }
  throw new ApiError(message, res.status, code);
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the backend server", 0, "NETWORK_ERROR");
  }
}

/** Reads a newline-delimited-JSON response body, invoking onLine for each non-empty line. */
export async function readNdjsonStream(res: Response, onLine: (line: string) => void): Promise<void> {
  if (!res.body) throw new ApiError("The server returned an empty response body", 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  }
  const trimmed = buffer.trim();
  if (trimmed) onLine(trimmed);
}
