import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the live backend health endpoint", async () => {
    const body = { status: "ok", app_name: "x", version: "1", environment: "dev", dependencies: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(api.health()).resolves.toEqual(body);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://localhost:8000/health");
  });

  it("uses /api/config for runtime configuration", async () => {
    const body = { app_name: "x", version: "1", environment: "dev", chat_max_message_chars: 8000, retrieval_top_k: 5, retrieval_min_score: 0.6 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(api.config()).resolves.toEqual(body);
  });

  it("lists sessions through /sessions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    await api.listSessions();
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://localhost:8000/sessions");
  });

  it("surfaces structured error messages from the backend error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 503, message: "Database unavailable" } }), { status: 503 }),
      ),
    );
    const error = await api.listSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).message).toBe("Database unavailable");
  });

  it("reports an unreachable backend as a network ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(api.listSessions()).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Could not reach") });
  });
});