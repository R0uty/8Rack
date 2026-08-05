import { useEffect, useState } from "react";
import { AppShell, CommandPalette, RightPanel, Sidebar, TopBar, type AppView } from "./components/layout";
import { ChatArea } from "./components/ChatArea";
import { PromptInput } from "./components/PromptInput";
import { SettingsPanel } from "./components/SettingsPanel";
import { OrchestratorWorkbench } from "./components/OrchestratorWorkbench";
import { MultiAgentPlanner } from "./components/MultiAgentPlanner";
import { useModels } from "./hooks/useModels";
import { useAgents } from "./hooks/useAgents";
import { useChat } from "./hooks/useChat";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import type { AgentWithStatus } from "./types/agent";
import type { ChatOptions } from "./types/chat";

function App() {
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useModels();
  const { agents, warnings: agentWarnings, loading: agentsLoading, error: agentsError, refresh: refreshAgents } =
    useAgents();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { messages, sending, sendMessage, cancel, clear } = useChat();
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [activeView, setActiveView] = useState<AppView>("chat");

  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].name);
    }
  }, [models, selectedModel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const ollamaStatus = modelsError ? "unavailable" : modelsLoading ? "unknown" : "connected";
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  const handleSelectAgent = (agent: AgentWithStatus) => {
    if (agent.id === selectedAgentId) {
      // Clicking the active agent again deselects it, handing model choice back to the user —
      // otherwise the model dropdown stays locked with nothing to unlock it.
      setSelectedAgentId(null);
      return;
    }
    setSelectedAgentId(agent.id);
    setSelectedModel(agent.model);
    updateSettings({ temperature: agent.temperature, topP: agent.topP, maxTokens: agent.maxTokens });
  };

  const handleSubmit = () => {
    if (!selectedAgentId && !selectedModel) return;

    const options: ChatOptions = {
      temperature: settings.temperature,
      top_p: settings.topP,
      ...(settings.maxTokens > 0 ? { num_predict: settings.maxTokens } : {}),
      ...(settings.contextSize > 0 ? { num_ctx: settings.contextSize } : {}),
    };

    sendMessage(prompt, {
      // When an agent is selected the backend Agent Manager supplies the model + system prompt;
      // otherwise fall back to the manually chosen model with no system prompt.
      ...(selectedAgentId ? { agentId: selectedAgentId } : { model: selectedModel ?? undefined }),
      options,
      keepAlive: settings.keepAlive,
    });
    setPrompt("");
  };

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            activeView={activeView}
            onChangeView={setActiveView}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onRefreshModels={refreshModels}
            modelLocked={!!selectedAgentId}
            agents={agents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            agentWarnings={agentWarnings}
            selectedAgentId={selectedAgentId}
            onSelectAgent={handleSelectAgent}
            onRefreshAgents={refreshAgents}
            ollamaStatus={ollamaStatus}
          />
        }
        topBar={
          <TopBar
            activeView={activeView}
            agentName={selectedAgent?.name ?? null}
            selectedModel={selectedModel}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
        }
        center={
          <>
            {activeView === "chat" && (
              <div className="flex h-full flex-col gap-4">
                <ChatArea
                  messages={messages}
                  onClear={clear}
                  agents={agents}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={handleSelectAgent}
                />
                <PromptInput
                  value={prompt}
                  onChange={setPrompt}
                  onSubmit={handleSubmit}
                  onCancel={cancel}
                  sending={sending}
                  disabled={!selectedModel}
                />
              </div>
            )}
            {activeView === "workbench" && (
              <OrchestratorWorkbench agents={agents} selectedAgentId={selectedAgentId} />
            )}
            {activeView === "plans" && <MultiAgentPlanner agents={agents} />}
          </>
        }
        rightPanel={
          activeView === "chat" ? (
            <RightPanel selectedAgent={selectedAgent} selectedModel={selectedModel} messageCount={messages.length} />
          ) : undefined
        }
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onReset={resetSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onChangeView={setActiveView}
        agents={agents}
        onSelectAgent={handleSelectAgent}
        models={models}
        onSelectModel={setSelectedModel}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
      />
    </>
  );
}

export default App;
