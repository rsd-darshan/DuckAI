import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("DuckAI UI error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          className="h-screen w-full flex items-center justify-center bg-panel-bg p-6 text-[color:var(--panel-text)]"
          role="alert"
        >
          <div className="max-w-md rounded-2xl border border-red-500/30 bg-red-500/10 p-5 shadow-panel space-y-3">
            <p className="text-sm font-semibold">Something went wrong</p>
            <p className="text-xs text-panel-muted leading-relaxed">
              The panel hit an unexpected error. You can reload to continue. If this keeps happening, check the developer
              console for details.
            </p>
            <pre className="text-[10px] text-panel-muted whitespace-pre-wrap break-all max-h-24 overflow-y-auto rounded-lg bg-panel-bg/80 p-2 border border-panel-border">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="focus-ring w-full rounded-lg border border-panel-border bg-panel-surface px-3 py-2 text-xs font-medium hover:bg-panel-bg motion-safe:transition-surface"
              onClick={() => window.location.reload()}
            >
              Reload DuckAI
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
