import { useEffect, useState } from "react";
import "./App.css";
import { Header, type AppView } from "./components/Header";
import { AgentSidebar } from "./components/AgentSidebar";
import { ChatArea } from "./components/ChatArea";
import { PromptInput } from "./components/PromptInput";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { OrchestratorWorkbench } from "./components/OrchestratorWorkbench";
import { useModels } from "./hooks/useModels";
import { useAgents } from "./hooks/useAgents";
import { useChat } from "./hooks/useChat";
import { useSettings } from "./hooks/useSettings";
import type { AgentWithStatus } from "./types/agent";
import type { ChatOptions } from "./types/chat";

function App() {
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useModels();
  const { agents, loading: agentsLoading, error: agentsError, refresh: refreshAgents } = useAgents();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { messages, sending, sendMessage, cancel, clear } = useChat();
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [activeView, setActiveView] = useState<AppView>("chat");

  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].name);
    }
  }, [models, selectedModel]);

  const ollamaStatus = modelsError ? "unavailable" : modelsLoading ? "unknown" : "connected";

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
    <div className="app-shell">
      <Header activeView={activeView} onChangeView={setActiveView} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="app-body">
        <AgentSidebar
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
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
          onRefreshAgents={refreshAgents}
        />
        {activeView === "chat" ? (
          <main className="chat-panel">
            <ChatArea messages={messages} onClear={clear} />
            <PromptInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={handleSubmit}
              onCancel={cancel}
              sending={sending}
              disabled={!selectedModel}
            />
          </main>
        ) : (
          <main className="workbench-panel">
            <OrchestratorWorkbench agents={agents} selectedAgentId={selectedAgentId} />
          </main>
        )}
      </div>
      <StatusBar ollamaStatus={ollamaStatus} selectedModel={selectedModel} />
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          onReset={resetSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
