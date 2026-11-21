import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, GlassPanel } from "./ui";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this changes (e.g. the user picks another view or mission), a caught error is cleared so
   * the new content gets a fresh try instead of the same error screen. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** The resetKey the current error was caught under. */
  errorKey?: unknown;
}

/** Keeps a render error in one view from blanking the whole app - the sidebar and mission switcher
 * stay usable, and the view can be retried or the page reloaded. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (!state.error) return { errorKey: props.resetKey };
    return props.resetKey !== state.errorKey ? { error: null, errorKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <GlassPanel padding="md" className="flex flex-col gap-3" role="alert">
        <p className="text-sm font-semibold text-text">This view hit an error and couldn't be shown.</p>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-critical">{this.state.error.message}</pre>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </GlassPanel>
    );
  }
}
