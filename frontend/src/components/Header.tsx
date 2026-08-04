export type AppView = "chat" | "workbench";

interface HeaderProps {
  activeView: AppView;
  onChangeView: (view: AppView) => void;
  onOpenSettings: () => void;
}

export function Header({ activeView, onChangeView, onOpenSettings }: HeaderProps) {
  return (
    <header className="app-header">
      <span className="app-header__title">8Rack</span>
      <span className="app-header__subtitle">Local Ollama Wrapper</span>
      <nav className="app-header__nav">
        <button
          type="button"
          className={`app-header__nav-item${activeView === "chat" ? " app-header__nav-item--active" : ""}`}
          onClick={() => onChangeView("chat")}
        >
          Chat
        </button>
        <button
          type="button"
          className={`app-header__nav-item${activeView === "workbench" ? " app-header__nav-item--active" : ""}`}
          onClick={() => onChangeView("workbench")}
        >
          Workbench
        </button>
      </nav>
      <button type="button" className="app-header__settings" onClick={onOpenSettings}>
        Settings
      </button>
    </header>
  );
}
