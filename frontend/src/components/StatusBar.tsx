import type { HealthStatus } from "../types";

interface Props {
  health: HealthStatus | null;
  backendDown: boolean;
  activeTitle?: string | null;
  onToggleSidebar?: () => void;
  onCreateSession?: () => void;
  hasArtifact?: boolean;
  onOpenArtifact?: () => void;
}

export function StatusBar({
  health,
  backendDown,
  activeTitle,
  onToggleSidebar,
  onCreateSession,
  hasArtifact,
  onOpenArtifact,
}: Props) {
  if (backendDown) {
    return (
      <header className="status-bar status-bar--down" role="alert">
        {onToggleSidebar && (
          <button
            type="button"
            className="mobile-nav-toggle"
            onClick={onToggleSidebar}
            aria-label="Toggle navigation sidebar"
          >
            ☰
          </button>
        )}
        <span className="status-dot status-dot--down" aria-hidden="true" />
        <span className="status-bar__text">
          Backend unreachable — ensure API is running on port 8000
        </span>
      </header>
    );
  }

  const ok = health?.status === "ok";
  const displayTitle = activeTitle || "New conversation";

  return (
    <header className="status-bar" role="banner" aria-label="Application header">
      <div className="status-bar__left">
        {onToggleSidebar && (
          <button
            type="button"
            className="mobile-nav-toggle"
            onClick={onToggleSidebar}
            aria-label="Toggle navigation sidebar"
            title="Open conversations"
          >
            <span aria-hidden="true">☰</span>
          </button>
        )}
        <div className="status-bar__title-wrapper">
          <h2 className="status-bar__title" title={displayTitle}>
            {displayTitle}
          </h2>
        </div>
      </div>

      <div className="status-bar__right">
        {hasArtifact && onOpenArtifact && (
          <button
            type="button"
            className="btn-artifact-pill"
            onClick={onOpenArtifact}
            aria-label="Open generated artifact"
          >
            <span aria-hidden="true">📄</span>
            <span>View Artifact</span>
          </button>
        )}

        {onCreateSession && (
          <button
            type="button"
            className="btn-header-new-chat"
            onClick={onCreateSession}
            aria-label="New chat"
            title="Start new conversation"
          >
            <span aria-hidden="true">+</span>
            <span className="btn-header-new-chat__label">New chat</span>
          </button>
        )}

        <div
          className={`system-health-pill ${ok ? "system-health-pill--ok" : "system-health-pill--degraded"}`}
          title={
            health
              ? `API: ${health.app_name} (${health.version}) | DB: ${health.dependencies.find((d) => d.name === "database")?.reachable ? "OK" : "Error"} | Agent: ${health.dependencies.find((d) => d.name === "agent_service")?.reachable ? "OK" : "Error"}`
              : "Checking system health..."
          }
          role="status"
          aria-label={ok ? "System healthy" : "System degraded"}
        >
          <span
            className={`status-dot ${ok ? "status-dot--ok" : "status-dot--degraded"}`}
            aria-hidden="true"
          />
          <span className="system-health-pill__label">
            {ok ? "System Online" : "Degraded"}
          </span>
          <span className="system-health-pill__model">llama3.2:3b</span>
        </div>
      </div>
    </header>
  );
}