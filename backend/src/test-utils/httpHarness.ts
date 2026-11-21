import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "../config/env.js";
import { createApp } from "../app.js";

export interface TestResponse {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests read arbitrary JSON
}

export interface TestServer {
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  close(): Promise<void>;
}

/**
 * The real app (every guard and mount path) on a random port. Requests carry the Host and Origin a
 * browser on the real frontend would send, so hostCheck/originCheck pass the way they do in use -
 * node:http rather than fetch, which won't set Host.
 */
export async function startTestServer(): Promise<TestServer> {
  const server: Server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    request(method, path, body, headers = {}) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: {
              Host: `localhost:${env.port}`,
              Origin: env.corsOrigin,
              ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
              ...headers,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf-8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => {
              let parsed: unknown = text;
              try {
                parsed = text ? JSON.parse(text) : undefined;
              } catch {
                // Not JSON - leave the text.
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          },
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
