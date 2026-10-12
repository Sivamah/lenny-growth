import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ArtifactRead } from "../types";

export interface ArtifactViewerProps {
  artifact: ArtifactRead | null;
  onClose: () => void;
}

export function ArtifactViewer({ artifact, onClose }: ArtifactViewerProps) {
  const [content, setContent] = useState<string>("");
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");

  useEffect(() => {
    if (!artifact) {
      setContent("");
      return;
    }

    if (artifact.kind === "markdown") {
      const processMarkdown = async () => {
        const rawHtml = await marked.parse(artifact.content);
        const cleanHtml = DOMPurify.sanitize(rawHtml, {
          ADD_TAGS: ["style"],
        });
        setContent(cleanHtml);
      };
      void processMarkdown();
    } else {
      // HTML
      const cleanHtml = DOMPurify.sanitize(artifact.content, {
        FORBID_TAGS: ["script", "form", "meta", "base", "object", "embed", "iframe"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onkeydown", "onkeyup", "onkeypress"],
        ADD_TAGS: ["style"],
        WHOLE_DOCUMENT: true,
        ALLOW_DATA_ATTR: false,
      });
      setContent(cleanHtml);
    }
  }, [artifact]);

  if (!artifact) {
    return (
      <div className="artifact-viewer empty-state">
        <div className="empty-message">No artifact generated yet.</div>
      </div>
    );
  }

  // The CSP prevents script execution and remote resources.
  const csp = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https:;";
  const isHtml = artifact.kind === "html";
  const iframeSrcDoc = isHtml
    ? content.includes("<head")
      ? content.replace(
          /<head[^>]*>/i,
          `$&<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        )
      : `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body { margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }</style></head><body>${content}</body></html>`
    : `<!DOCTYPE html>
    <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 1.5rem; color: #e4e4e7; background: #18181b; line-height: 1.6; }
          h1, h2, h3, h4, h5, h6 { color: #f4f4f5; font-weight: 600; margin-top: 1.5em; margin-bottom: 0.5em; }
          a { color: #3b82f6; text-decoration: none; }
          a:hover { text-decoration: underline; }
          code { background: #27272a; padding: 0.2em 0.4em; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
          pre { background: #27272a; padding: 1em; border-radius: 8px; overflow-x: auto; }
          pre code { background: none; padding: 0; }
          blockquote { border-left: 4px solid #3f3f46; margin-left: 0; padding-left: 1em; color: #a1a1aa; }
          table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          th, td { border: 1px solid #3f3f46; padding: 0.75em; text-align: left; }
          th { background: #27272a; }
        </style>
      </head>
      <body>
        ${content}
      </body>
    </html>`;

  return (
    <div className="artifact-viewer">
      <div className="artifact-header">
        <div className="artifact-title">
          <h3>{artifact.title || "Generated Artifact"}</h3>
          <span className="artifact-badge">{artifact.kind.toUpperCase()}</span>
        </div>
        <div className="artifact-view-toggle" role="tablist" aria-label="Artifact view mode">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "preview"}
            className={`artifact-toggle-btn ${viewMode === "preview" ? "active" : ""}`}
            onClick={() => setViewMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "source"}
            className={`artifact-toggle-btn ${viewMode === "source" ? "active" : ""}`}
            onClick={() => setViewMode("source")}
          >
            Source
          </button>
        </div>
        <button onClick={onClose} className="artifact-close-btn" aria-label="Close artifact">
          ✕
        </button>
      </div>
      <div className="artifact-content-wrapper">
        {viewMode === "preview" ? (
          <iframe
            title={artifact.title || "Artifact"}
            sandbox="" // empty string means NO permissions: no scripts, no same-origin, etc.
            srcDoc={iframeSrcDoc}
            className="artifact-iframe"
          />
        ) : (
          <div className="artifact-source-view">
            <pre>
              <code>{artifact.content}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
