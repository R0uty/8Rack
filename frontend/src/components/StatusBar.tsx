interface StatusBarProps {
  ollamaStatus: "unknown" | "connected" | "unavailable";
  selectedModel: string | null;
}

export function StatusBar({ ollamaStatus, selectedModel }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span className="status-bar__item">Ollama: {ollamaStatus}</span>
      <span className="status-bar__item">Model: {selectedModel ?? "none selected"}</span>
    </footer>
  );
}
