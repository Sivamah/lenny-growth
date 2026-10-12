/** Renders citations returned by the backend for an assistant message. */
import type { Citation } from "../types";

interface Props {
  citations: Citation[];
}

function formatScore(score: number | null): string | null {
  if (score === null) return null;
  return score.toFixed(2);
}

export function Citations({ citations }: Props) {
  if (citations.length === 0) return null;

  return (
    <div className="citations" aria-label="Sources">
      <div className="citations__label">
        <span className="citations__label-icon" aria-hidden="true">🎙️</span>
        <span>Verified Sources & Transcripts ({citations.length})</span>
      </div>
      <ul className="citations__list">
        {citations.map((c, i) => {
          const title =
            c.episode?.trim() || c.guest?.trim() || "Transcript passage";
          const key = `${c.episode ?? "e"}-${c.timestamp ?? "t"}-${i}`;

          const headerContent = (
            <div className="citations__item-header">
              <span className="citations__guest">{c.guest ?? "Unknown guest"}</span>
              {c.episode && (
                <>
                  <span className="citation-sep" aria-hidden="true">—</span>
                  <span className="citations__episode" title={c.episode}>{title}</span>
                </>
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
            <li key={key}>
              <div className="citations__item">
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="citations__link"
                    title="Open the cited transcript source"
                  >
                    {headerContent}
                    <span className="citations__link-icon" aria-hidden="true">↗</span>
                  </a>
                ) : (
                  headerContent
                )}
                {c.snippet && (
                  <p className="citations__snippet">"{c.snippet}"</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
