import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { screen } from "@testing-library/dom";
import { Composer } from "./Composer";

describe("Composer - Artifact Mode", () => {
  it("clicking Artifact button activates Artifact Mode without submitting", () => {
    const onSend = vi.fn();
    const onArtifact = vi.fn();

    render(
      <Composer
        streaming={false}
        disabled={false}
        maxLength={4000}
        onSend={onSend}
        onEssay={vi.fn()}
        onArtifact={onArtifact}
        onStop={vi.fn()}
      />
    );

    const artifactBtn = screen.getByRole("button", { name: /generate an artifact/i });
    fireEvent.click(artifactBtn);

    // Should NOT automatically submit
    expect(onSend).not.toHaveBeenCalled();
    expect(onArtifact).not.toHaveBeenCalled();

    // Placeholder updates
    const textarea = screen.getByPlaceholderText("Describe the artifact you want to create...");
    expect(textarea).toBeInTheDocument();

    // Cancel button is shown
    expect(screen.getByRole("button", { name: /cancel artifact mode/i })).toBeInTheDocument();
  });

  it("submitting in Artifact Mode dispatches onArtifact with custom instruction", () => {
    const onSend = vi.fn();
    const onArtifact = vi.fn();

    render(
      <Composer
        streaming={false}
        disabled={false}
        maxLength={4000}
        onSend={onSend}
        onEssay={vi.fn()}
        onArtifact={onArtifact}
        onStop={vi.fn()}
      />
    );

    // Activate Artifact Mode
    fireEvent.click(screen.getByRole("button", { name: /generate an artifact/i }));

    const textarea = screen.getByPlaceholderText("Describe the artifact you want to create...");
    fireEvent.change(textarea, { target: { value: "Build an interactive pricing calculator" } });

    // Submit
    const sendBtn = screen.getByRole("button", { name: /send message/i });
    fireEvent.click(sendBtn);

    expect(onArtifact).toHaveBeenCalledWith("Build an interactive pricing calculator");
    expect(onSend).not.toHaveBeenCalled();

    // Artifact mode is deactivated after submit
    expect(screen.getByPlaceholderText(/ask a product or growth question/i)).toBeInTheDocument();
  });

  it("pressing Escape cancels Artifact Mode", () => {
    render(
      <Composer
        streaming={false}
        disabled={false}
        maxLength={4000}
        onSend={vi.fn()}
        onEssay={vi.fn()}
        onArtifact={vi.fn()}
        onStop={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /generate an artifact/i }));
    const textarea = screen.getByPlaceholderText("Describe the artifact you want to create...");

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.getByPlaceholderText(/ask a product or growth question/i)).toBeInTheDocument();
  });

  it("clicking Cancel button cancels Artifact Mode", () => {
    render(
      <Composer
        streaming={false}
        disabled={false}
        maxLength={4000}
        onSend={vi.fn()}
        onEssay={vi.fn()}
        onArtifact={vi.fn()}
        onStop={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /generate an artifact/i }));
    const cancelBtn = screen.getByRole("button", { name: /cancel artifact mode/i });
    fireEvent.click(cancelBtn);

    expect(screen.getByPlaceholderText(/ask a product or growth question/i)).toBeInTheDocument();
  });

  it("normal submit calls onSend when not in Artifact Mode", () => {
    const onSend = vi.fn();
    const onArtifact = vi.fn();

    render(
      <Composer
        streaming={false}
        disabled={false}
        maxLength={4000}
        onSend={onSend}
        onEssay={vi.fn()}
        onArtifact={onArtifact}
        onStop={vi.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText(/ask a product or growth question/i);
    fireEvent.change(textarea, { target: { value: "How do I optimize activation?" } });

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("How do I optimize activation?");
    expect(onArtifact).not.toHaveBeenCalled();
  });
});
