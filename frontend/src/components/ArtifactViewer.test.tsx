import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ArtifactViewer } from "./ArtifactViewer";
import type { ArtifactRead } from "../types";

function makeArtifact(partial: Partial<ArtifactRead>): ArtifactRead {
  return {
    id: "a-1",
    session_id: "s-1",
    message_id: "m-1",
    kind: "html",
    title: "Test",
    created_at: "2026-01-01T00:00:00Z",
    content: "",
    ...partial,
  };
}

function srcdoc(container: HTMLElement): string {
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  return (frame as HTMLIFrameElement).getAttribute("srcdoc") ?? "";
}

describe("ArtifactViewer sanitization", () => {
  it("strips scripts and inline event handlers from HTML artifacts before rendering", () => {
    const { container } = render(
      <ArtifactViewer
        artifact={makeArtifact({
          kind: "html",
          content:
            '<h1>Growth audit</h1><script>alert("xss")</script>' +
            '<img src="data:image/png;base64,AAAA" onerror="alert(1)">' +
            '<a href="http://evil.example" onclick="alert(2)">link</a>',
        })}
        onClose={() => undefined}
      />,
    );

    const doc = srcdoc(container);
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/onerror/i);
    expect(doc).not.toMatch(/onclick/i);
    expect(doc).toContain("<h1>Growth audit</h1>");
  });

  it("sanitizes markdown artifacts (raw HTML and javascript: links) too", async () => {
    const { container } = render(
      <ArtifactViewer
        artifact={makeArtifact({
          kind: "markdown",
          content:
            "# Checklist\n\n[click](javascript:alert(1))\n\n<img src=\"x\" onerror=\"alert(1)\">",
        })}
        onClose={() => undefined}
      />,
    );

    // marked.parse runs asynchronously; wait for the sanitized content to land.
    await waitFor(
      () => {
        expect(srcdoc(container)).toContain("Checklist");
      },
      { timeout: 2000 },
    );

    const doc = srcdoc(container);
    expect(doc).toMatch(/<h1[^>]*>Checklist<\/h1>/i);
    expect(doc).not.toMatch(/javascript:/i);
    expect(doc).not.toMatch(/onerror/i);
    expect(doc).not.toMatch(/<script/i);
  });

  it("renders artifacts in a sandboxed iframe with a strict CSP", () => {
    const { container } = render(
      <ArtifactViewer
        artifact={makeArtifact({ kind: "html", content: "<p>ok</p>" })}
        onClose={() => undefined}
      />,
    );

    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    const doc = srcdoc(container);
    expect(doc).toMatch(/Content-Security-Policy/i);
    expect(doc).toMatch(/default-src 'none'/);
  });

  it("preserves safe inline <style> tags in HTML artifacts", () => {
    const { container } = render(
      <ArtifactViewer
        artifact={makeArtifact({
          kind: "html",
          content: "<style>.hero { color: #8b5cf6; }</style><div class=\"hero\">Hero Title</div>",
        })}
        onClose={() => undefined}
      />,
    );

    const doc = srcdoc(container);
    expect(doc).toContain("<style>.hero { color: #8b5cf6; }</style>");
    expect(doc).toContain("Hero Title");
  });

  it("toggles between preview and source views", async () => {
    const rawContent = "<div class=\"app\"><h1>Landing Page</h1></div>";
    const { container, getByRole } = render(
      <ArtifactViewer
        artifact={makeArtifact({ kind: "html", content: rawContent })}
        onClose={() => undefined}
      />,
    );

    // Initial state: Preview mode with iframe
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector(".artifact-source-view")).toBeNull();

    // Click "Source" tab
    const sourceBtn = getByRole("tab", { name: "Source" });
    fireEvent.click(sourceBtn);

    // Source mode: No iframe, source code block visible
    expect(container.querySelector("iframe")).toBeNull();
    const sourceView = container.querySelector(".artifact-source-view");
    expect(sourceView).not.toBeNull();
    expect(sourceView?.textContent).toContain(rawContent);

    // Click "Preview" tab
    const previewBtn = getByRole("tab", { name: "Preview" });
    fireEvent.click(previewBtn);

    // Back to Preview mode
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector(".artifact-source-view")).toBeNull();
  });

  it("shows empty state when artifact is null", () => {
    const { container } = render(<ArtifactViewer artifact={null} onClose={() => undefined} />);
    expect(container.querySelector(".empty-state")).not.toBeNull();
    expect(container.textContent).toContain("No artifact generated yet.");
  });
});