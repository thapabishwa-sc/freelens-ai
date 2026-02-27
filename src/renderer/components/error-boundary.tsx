import React from "react";
import { logger } from "../services/logger";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  label?: string;
}

interface ErrorBoundaryState {
  error: string | null;
}

/**
 * Generic error boundary that catches render errors in child components.
 * Displays a recoverable error message with a Retry button.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.message || "An unexpected error occurred" };
  }

  componentDidCatch(err: Error) {
    logger.error(`Render error in ${this.props.label || "component"}:`, err);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, color: "var(--textColorDimmed, #999)" }}>
          <div style={{ marginBottom: 8 }}>
            {this.props.label || "Component"} error: {this.state.error}
          </div>
          <button
            type="button"
            className="flai-btn flai-btn--primary"
            onClick={() => this.setState({ error: null })}
            aria-label="Retry after error"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
