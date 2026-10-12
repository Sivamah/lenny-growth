import { useState, useEffect } from "react";
import type { Citation } from "../types";

interface Props {
  citations: Citation[];
  messageId?: string;
  activeSourceIndex?: number | null;
}

function formatScore(score: number | null | undefined): string | null {
  if (score === null || score === undefined) return null;
  return score.toFixed(2);
}

function isValidHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function Citations({ citations, messageId, activeSourceIndex }: Props) {
  const [expandedIndices, setExpandedIndices] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (activeSourceIndex != null) {
      setExpandedIndices((prev) => ({ ...prev, [activeSourceIndex]: true }));
    }
  }, [activeSourceIndex]);

  if (!citations || citations.length === 0) return null;

  const toggleExpand = (idx: number) => {
    setExpandedIndices((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  };

  return (
    <div className="citations" aria-label="Sources">
      <div className="citations__label">
        <span className="citations__label-icon" aria-hidden="true">🎙️</span>
        <span>Sources ({citations.length})</span>
      </div>
      <ul className="citations__list">
        {citations.map((c, i) => {
          const displayIndex = c.index ?? i + 1;
          const isHighlighted = activeSourceIndex === displayIndex;
          const isExpanded = !!expandedIndices[displayIndex];

          const title = c.episode?.trim() || "Lenny's Podcast Transcript";
          const speakerName = c.speaker?.trim() || c.guest?.trim() || null;
          const hasSafeUrl = isValidHttpUrl(c.url);
          const anchorId = `source-${messageId ? `${messageId}-` : ""}${displayIndex}`;

          const headerDetails = (
            <div className="citations__item-header">
              <span className="citations__index" aria-label={`Source citation ${displayIndex}`}>
                [{displayIndex}]
              </span>
              {speakerName && (
                <span className="citations__guest">{speakerName}</span>
              )}
              {speakerName && c.episode && (
                <span className="citation-sep" aria-hidden="true">—</span>
              )}
              {(!speakerName || c.episode) && (
                <span className="citations__episode" title={title}>
                  {title}
                </span>
              )}
              {c.timestamp && (
                <span className="citations__time" title={`Timestamp: ${c.timestamp}`}>
                  ⏱ {c.timestamp}
                </span>
              )}
              {formatScore(c.score) !== null && (
                <span className="citations__score" title={`Relevance score: ${formatScore(c.score)}`}>
                  ★ {formatScore(c.score)}
                </span>
              )}
            </div>
          );

          return (
            <li key={c.chunk_id ?? `${displayIndex}-${c.timestamp ?? i}`}>
              <div
                id={anchorId}
                className={`citations__item ${isHighlighted ? "is-highlighted" : ""}`}
                tabIndex={0}
              >
                {hasSafeUrl ? (
                  <a
                    href={c.url!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="citations__link"
                    title={`Open source: ${title}${speakerName ? ` (${speakerName})` : ""}`}
                    aria-label={`Open transcript: ${title} (${speakerName ?? "Guest"})`}
                  >
                    {headerDetails}
                    <span className="citations__link-icon" aria-hidden="true">↗</span>
                  </a>
                ) : (
                  headerDetails
                )}

                {/* Excerpt Section */}
                {c.snippet && (
                  <div className="citations__snippet-wrapper">
                    <p className={`citations__snippet ${isExpanded ? "is-expanded" : "is-collapsed"}`}>
                      "{c.snippet}"
                    </p>
                    {c.snippet.length > 100 && (
                      <button
                        type="button"
                        className="citations__expand-btn"
                        onClick={() => toggleExpand(displayIndex)}
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? `Collapse excerpt for source [${displayIndex}]` : `Expand excerpt for source [${displayIndex}]`}
                      >
                        {isExpanded ? "Show less ▴" : "Show full excerpt ▾"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
