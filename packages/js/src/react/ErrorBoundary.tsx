import { Component, type ErrorInfo, type ReactNode } from "react";
import { capture } from "../index";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Tags for errors caught by this boundary, on top of the scope tags. */
  tags?: string[];
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    capture(error.message, { componentStack: info.componentStack }, { tags: this.props.tags });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
