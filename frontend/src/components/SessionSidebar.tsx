import { useMemo, useState } from "react";
import type { SessionSummary } from "../types";

interface Props {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  loading: boolean;
  theme: "light" | "dark" | "system";
  onThemeChange: (theme: "light" | "dark" | "system") => void;
  isOpenOnMobile?: boolean;
  onCloseMobile?: () => void;
}

function sessionLabel(session: SessionSummary): string {
  return session.title ?? session.user_label ?? "Untitled conversation";
}

function getDateGroup(isoString: string): "Today" | "Previous 7 Days" | "Older" {
  try {
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays <= 7) return "Previous 7 Days";
    return "Older";
  } catch {
    return "Older";
  }
}

interface RenameFormProps {
  currentTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}

function RenameForm({ currentTitle, onSave, onCancel }: RenameFormProps) {
  const [value, setValue] = useState(
    currentTitle === "Untitled conversation" ? "" : currentTitle,
  );

  return (
    <form
      className="sidebar__rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        const title = value.trim();
        if (title) onSave(title);
        else onCancel();
      }}
    >
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={200}
        placeholder="Conversation title"
        className="sidebar__rename-input"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="sidebar__rename-actions">
        <button type="submit" className="sidebar__rename-save">
          Save
        </button>
        <button type="button" onClick={onCancel} className="sidebar__rename-cancel">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  loading,
  theme,
  onThemeChange,
  isOpenOnMobile,
  onCloseMobile,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Deduplicate sessions by ID strictly
  const uniqueSessions = useMemo(() => {
    const seen = new Set<string>();
    return sessions.filter((s) => {
      if (!s?.id || seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [sessions]);

  // Filter sessions by search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return uniqueSessions;
    const q = searchQuery.toLowerCase().trim();
    return uniqueSessions.filter((s) => {
      const label = sessionLabel(s).toLowerCase();
      return label.includes(q);
    });
  }, [uniqueSessions, searchQuery]);

  // Group filtered sessions chronologically
  const groupedSessions = useMemo(() => {
    const groups: { [key in "Today" | "Previous 7 Days" | "Older"]: SessionSummary[] } = {
      Today: [],
      "Previous 7 Days": [],
      Older: [],
    };
    for (const session of filteredSessions) {
      const group = getDateGroup(session.created_at);
      groups[group].push(session);
    }
    return groups;
  }, [filteredSessions]);

  const handleSelectSession = (id: string) => {
    onSelect(id);
    onCloseMobile?.();
  };

  const handleCreateSession = () => {
    onCreate();
    onCloseMobile?.();
  };

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`sidebar-backdrop ${isOpenOnMobile ? "sidebar-backdrop--visible" : ""}`}
        onClick={onCloseMobile}
        aria-hidden="true"
      />

      <nav
        className={`sidebar ${isOpenOnMobile ? "sidebar--mobile-open" : ""}`}
        aria-label="Chat sessions"
      >
        {/* Brand Header */}
        <div className="sidebar__header">
          <div className="sidebar__brand">
            <div className="sidebar__brand-logo" aria-hidden="true">
              <span>LGS</span>
            </div>
            <div className="sidebar__brand-text">
              <span className="sidebar__brand-name">Lenny Studio</span>
              <span className="sidebar__brand-badge">PRO V2</span>
            </div>
            {onCloseMobile && (
              <button
                type="button"
                className="sidebar__close-mobile-btn"
                onClick={onCloseMobile}
                aria-label="Close menu"
              >
                ✕
              </button>
            )}
          </div>

          <button
            type="button"
            id="sidebar-new-chat-btn"
            className="sidebar__new-chat"
            onClick={handleCreateSession}
            disabled={loading}
            aria-label="Start a new conversation"
          >
            <span className="sidebar__new-chat-icon" aria-hidden="true">+</span>
            <span>New conversation</span>
          </button>
        </div>

        {/* Real-time search filter */}
        <div className="sidebar__search-box">
          <span className="sidebar__search-icon" aria-hidden="true">🔍</span>
          <input
            type="text"
            className="sidebar__search-input"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Filter conversations"
          />
          {searchQuery && (
            <button
              type="button"
              className="sidebar__search-clear"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Conversations List with Date Grouping */}
        <div className="sidebar__list-container">
          {filteredSessions.length === 0 ? (
            <div className="sidebar__empty">
              {searchQuery ? "No matching conversations" : "No conversations yet"}
            </div>
          ) : (
            (["Today", "Previous 7 Days", "Older"] as const).map((groupName) => {
              const groupItems = groupedSessions[groupName];
              if (groupItems.length === 0) return null;

              return (
                <div key={groupName} className="sidebar__group">
                  <div className="sidebar__section-label">{groupName}</div>
                  <ul className="sidebar__list" role="list">
                    {groupItems.map((session) => {
                      const label = sessionLabel(session);
                      const isActive = session.id === activeSessionId;
                      const isConfirmingDelete = confirmDeleteId === session.id;
                      const isRenaming = renamingId === session.id;

                      return (
                        <li key={session.id} className="sidebar__item-wrapper">
                          <div
                            className={`sidebar__item${isActive ? " sidebar__item--active" : ""}`}
                          >
                            {isRenaming ? (
                              <RenameForm
                                currentTitle={label}
                                onSave={(title) => {
                                  setRenamingId(null);
                                  onRename?.(session.id, title);
                                }}
                                onCancel={() => setRenamingId(null)}
                              />
                            ) : isConfirmingDelete ? (
                              <div className="sidebar__confirm-delete">
                                <span className="sidebar__confirm-text">Delete?</span>
                                <button
                                  type="button"
                                  className="sidebar__item-action sidebar__item-action--danger"
                                  onClick={() => {
                                    setConfirmDeleteId(null);
                                    onDelete?.(session.id);
                                  }}
                                  aria-label="Confirm delete"
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  className="sidebar__item-action"
                                  onClick={() => setConfirmDeleteId(null)}
                                  aria-label="Cancel delete"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="sidebar__item-btn"
                                  onClick={() => handleSelectSession(session.id)}
                                  aria-current={isActive ? "true" : undefined}
                                  title={label}
                                >
                                  <span className="sidebar__item-title">{label}</span>
                                </button>
                                <div className="sidebar__item-actions">
                                  {onRename && (
                                    <button
                                      type="button"
                                      className="sidebar__item-action"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setRenamingId(session.id);
                                      }}
                                      aria-label={`Rename "${label}"`}
                                      title="Rename"
                                    >
                                      ✏
                                    </button>
                                  )}
                                  {onDelete && (
                                    <button
                                      type="button"
                                      className="sidebar__item-action sidebar__item-action--danger"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setConfirmDeleteId(session.id);
                                      }}
                                      aria-label={`Delete "${label}"`}
                                      title="Delete"
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Workspace & Theme Footer */}
        <div className="sidebar__footer">
          <div className="sidebar__theme-row">
            <span className="sidebar__theme-label">Theme</span>
            <div className="sidebar__theme-selector">
              {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`theme-pill ${theme === t ? "theme-pill--active" : ""}`}
                  onClick={() => onThemeChange(t)}
                  aria-label={`Select ${t} theme`}
                >
                  {t === "light" ? "☀️ Light" : t === "dark" ? "🌙 Dark" : "💻 Auto"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}