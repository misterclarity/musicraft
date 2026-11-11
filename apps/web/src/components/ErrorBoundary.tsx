import { Component, type ReactNode } from "react";

/** Shows `fallback` instead of crashing when a part of the screen fails (e.g. no WebGL for the 3D stage). */
export class ErrorBoundary extends Component<{ fallback: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
