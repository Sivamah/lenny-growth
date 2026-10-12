import { api } from "../src/api/client";
import { streamChat } from "../src/api/sse";
import type { ChatEvent, SessionSummary } from "../src/types";

const started = Date.now();
let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

interface TurnResult {
  summary: Awaited<ReturnType<typeof streamChat>>;
  eventTypes: string[];
}

async function runTurn(
  sessionId: string,
  message: string,
  opts: { abortOnFirstDelta?: boolean } = {},
): Promise<TurnResult> {
  const controller = new AbortController();
  const eventTypes: string[] = [];
  let deltas = 0;
  const promise = streamChat(sessionId, message, {
    signal: controller.signal,
    onEvent: (e: ChatEvent) => {
      eventTypes.push(e.type);
      if (opts.abortOnFirstDelta && e.type === "text_delta") {
        deltas++;
        if (deltas === 1) controller.abort();
      }
    },
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("turn timed out after 180s")), 180_000),
  );
  return { summary: await Promise.race([promise, timeout]), eventTypes };
}

async function renamePersists(session: SessionSummary): Promise<void> {
  const title = "Live check session rename";
  const renamed = await api.renameSession(session.id, title);
  check("rename PATCH updates title", renamed.title === title, renamed.title ?? "null");
  const listed = (await api.listSessions()).find((s) => s.id === session.id);
  check("rename persists in listing", listed?.title === title, listed?.title ?? "missing");
}

async function stopGeneration(sessionId: string): Promise<void> {
  const controller = new AbortController();
  let deltas = 0;
  let abortedName = "";
  try {
    await streamChat(sessionId, "Explain in detail what mistake 99% of founders and sales reps make and how to avoid it.", {
      signal: controller.signal,
      onEvent: (e: ChatEvent) => {
        if (e.type === "text_delta") {
          deltas++;
          if (deltas === 1) controller.abort();
        }
      },
    });
  } catch (err) {
    abortedName = err instanceof Error ? err.name : String(err);
  }
  check("stop raises AbortError", abortedName === "AbortError", abortedName);
  check("stop occurs mid-stream", deltas >= 1, `${deltas} deltas received`);
  const msgs = await api.getMessages(sessionId);
  const assistant = msgs.filter((m) => m.role === "assistant");
  const lastContent = assistant[assistant.length - 1]?.content ?? "";
  check(
    "stop persists partial assistant message",
    assistant.length >= 1 && lastContent.length > 0,
    `${assistant.length} assistant msg(s), content len=${lastContent.length}`,
  );
}

async function main(): Promise<void> {
  const health = await api.health();
  check("health ok", health.status === "ok", `${health.app_name} v${health.version} (${health.environment})`);
  check("health dependencies listed", Array.isArray(health.dependencies) && health.dependencies.length > 0);

  const config = await api.config();
  check("config chat_max_message_chars=8000", config.chat_max_message_chars === 8000, `got ${config.chat_max_message_chars}`);
  check("config retrieval_top_k > 0", typeof config.retrieval_top_k === "number" && config.retrieval_top_k > 0, `got ${config.retrieval_top_k}`);
  check(
    "config retrieval_min_score in [0,1]",
    typeof config.retrieval_min_score === "number" && config.retrieval_min_score >= 0 && config.retrieval_min_score <= 1,
    `got ${config.retrieval_min_score}`,
  );

  console.log(".. creating session A");
  const a = await api.createSession();
  check("create session A", typeof a.id === "string" && a.id.length > 0, a.id);
  check("session A starts untitled", a.title === null || a.title === "", a.title ?? "null");
  const listing = await api.listSessions();
  check("A appears in session list", listing.some((s) => s.id === a.id), `${listing.length} sessions`);

  console.log(".. turn 1 (in-corpus)");
  const turn1 = await runTurn(a.id, "What mistake do 99% of founders and sales reps make, according to Jason Lemkin?");
  check("turn1 grounded=true", turn1.summary.grounded === true, `stream grounded=${turn1.summary.grounded}`);
  check("turn1 citations event fired", turn1.eventTypes.includes("citations"), turn1.eventTypes.join(","));
  check("turn1 turn_end message id", typeof turn1.summary.messageId === "string" && turn1.summary.messageId.length > 0, `id=${turn1.summary.messageId}`);

  const msgsA = await api.getMessages(a.id);
  const lastA = msgsA[msgsA.length - 1];
  check("A has user + assistant messages", msgsA.length >= 2, `${msgsA.length} messages`);
  check("A last message is assistant", lastA.role === "assistant");
  check("A citations persisted", Array.isArray(lastA.citations) && lastA.citations.length > 0, `${lastA.citations.length} citations`);
  check("A grounding persisted", lastA.grounding?.grounded === true, JSON.stringify(lastA.grounding));
  check("A model + provider persisted", Boolean(lastA.model) && Boolean(lastA.provider), `${lastA.provider}/${lastA.model}`);

  console.log(".. reload / restore");
  const listedAgain = await api.listSessions();
  const aAgain = listedAgain.find((s) => s.id === a.id);
  const msgsAgain = await api.getMessages(a.id);
  check("reload finds session A", Boolean(aAgain));
  check("reload restores same messages", msgsAgain.length === msgsA.length && msgsAgain[msgsAgain.length - 1].id === lastA.id, `${msgsAgain.length} msgs`);

  console.log(".. session B (isolation + out-of-corpus)");
  const b = await api.createSession();
  await renamePersists(b);
  await runTurn(b.id, "What mistake do 99% of founders and sales reps make, according to Jason Lemkin?");
  const msgsA2 = await api.getMessages(a.id);
  check("session A unaffected by B", msgsA2.length === msgsA.length, `${msgsA2.length} vs ${msgsA.length}`);

  console.log(".. turn 3 (out-of-corpus)");
  const turn3 = await runTurn(b.id, "Describe the plot of Pride and Prejudice.");
  const msgsB = await api.getMessages(b.id);
  const lastB = msgsB[msgsB.length - 1];
  const groundedFalse = turn3.summary.grounded === false || lastB.grounding?.grounded === false;
  check("out-of-corpus grounded=false", groundedFalse, `stream=${turn3.summary.grounded} persisted=${lastB.grounding?.grounded}`);
  check("B conversation isolated from A", msgsB[0].id !== msgsA[0].id, "distinct first message ids");

  console.log(".. stop-generation");
  const c = await api.createSession();
  await stopGeneration(c.id);

  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s, failures=${failures}`);
  process?.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("live-check crashed:", err);
  process?.exit(2);
});