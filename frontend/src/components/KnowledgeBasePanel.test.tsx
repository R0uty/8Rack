import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeBasePanel } from "./KnowledgeBasePanel";
import { useRag } from "../hooks/useRag";
import type { RagIndexStatus } from "../types/rag";

vi.mock("../hooks/useRag", () => ({ useRag: vi.fn() }));

function setup(status: RagIndexStatus | null, overrides: Partial<ReturnType<typeof useRag>> = {}) {
  const reindex = vi.fn();
  vi.mocked(useRag).mockReturnValue({ status, loading: false, reindexing: false, error: null, refresh: vi.fn(), reindex, ...overrides });
  return { reindex };
}

const STATUS: RagIndexStatus = {
  indexedAt: Date.now(),
  fileCount: 2,
  chunkCount: 3,
  embeddingModel: "nomic-embed-text",
  workspaceRoot: "/srv/review",
};

describe("KnowledgeBasePanel", () => {
  it("shows the local index", () => {
    setup(STATUS);
    render(<KnowledgeBasePanel />);
    expect(screen.getByText("3 chunks across 2 files")).toBeInTheDocument();
    expect(screen.getByText("Local index on this machine")).toBeInTheDocument();
  });

  it("names the MCP server that serves the index", () => {
    setup({ ...STATUS, server: "rag" });
    render(<KnowledgeBasePanel />);
    expect(screen.getByText(/Served by MCP server/)).toHaveTextContent("Served by MCP server rag");
  });

  it("shows why the server couldn't be reached, and still offers a reindex", async () => {
    const { reindex } = setup(null, { error: 'MCP server "rag": connect ECONNREFUSED 127.0.0.1:8766' });
    render(<KnowledgeBasePanel />);
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reindex" }));
    expect(reindex).toHaveBeenCalled();
  });
});
