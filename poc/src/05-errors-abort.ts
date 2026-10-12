import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_DIR,
  POC_ROOT,
  MODELS_BAD_PATH,
  OLLAMA_MODEL,
  OLLAMA_PROVIDER,
  createRuntime,
  banner,
  section,
} from "./common.ts";

async function testBadEndpoint(): Promise<void> {
  banner("PoC 05a - error handling: unreachable baseUrl (http://localhost:59999/v1)");

  const runtime = await createRuntime(MODELS_BAD_PATH);
  const model = runtime.getModel("ollama-bad", OLLAMA_MODEL);
  if (!model) {
    console.log("UNEXPECTED: bad model could not be resolved from runtime");
    return;
  }

  const { session } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  let promptError: string | undefined;
  let resolved = false;
  let settledError: any;
  const events: any[] = [];
  const unsub = session.subscribe((event: any) => {
    events.push(event);
    if (event.type === "agent_settled") {
      settledError = event.error;
    }
    if (event.type === "error" || event.error) {
      settledError = settledError || event.error;
    }
  });

  try {
    await session.prompt("Say hi");
    resolved = true;
  } catch (err: any) {
    promptError = err?.message ?? String(err);
  } finally {
    unsub();
    session.dispose();
  }

  let agentEndWillRetry: boolean | undefined;
  let agentEndErrorMsg: string | undefined;
  let autoRetryEndSuccess: boolean | undefined;
  let autoRetryEndError: string | undefined;
  let hasErrorStopReason = false;

  for (const e of events) {
    if (e.type === "agent_end") {
      agentEndWillRetry = e.willRetry;
      if (e.messages) {
        for (const m of e.messages) {
          if (m.role === "assistant" && m.stopReason === "error") {
            hasErrorStopReason = true;
          }
          if (m.role === "assistant" && m.errorMessage) {
            agentEndErrorMsg = agentEndErrorMsg || m.errorMessage;
          }
        }
      }
      agentEndErrorMsg = agentEndErrorMsg || e.errorMessage;
    }
    if (e.type === "auto_retry_end") {
      autoRetryEndSuccess = e.success;
      autoRetryEndError = e.finalError;
    }
  }

  section("results");
  console.log("prompt resolved unexpectedly =", resolved);
  console.log("error captured               =", promptError ? "yes" : "no");
  console.log("error message                =", promptError);
  console.log("agent_settled.error          =", settledError ? (settledError.message || settledError) : "none");
  console.log("agent_end.willRetry          =", agentEndWillRetry);
  console.log("agent_end.errorMessage       =", agentEndErrorMsg);
  console.log("auto_retry_end.success       =", autoRetryEndSuccess);
  console.log("auto_retry_end.finalError    =", autoRetryEndError);
  console.log("assistant stopReason='error' =", hasErrorStopReason);
  console.log("event types (last30)         =", events.slice(-30).join(","));

  const errorDetected =
    hasErrorStopReason ||
    !!agentEndErrorMsg ||
    !!autoRetryEndError ||
    autoRetryEndSuccess === false ||
    agentEndWillRetry === false ||
    !!settledError ||
    (!resolved && !!promptError);

  console.log("RESULT:", errorDetected ? "PASS - error surfaced to caller" : "FAIL - no error surfaced");
}

async function testAbort(): Promise<void> {
  banner("PoC 05b - abort() mid-generation");

  const runtime = await createRuntime();
  const model = runtime.getModel(OLLAMA_PROVIDER, OLLAMA_MODEL);
  if (!model) throw new Error(`Model ${OLLAMA_PROVIDER}/${OLLAMA_MODEL} not found`);

  const { session } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  let streamed = "";
  let settledAborted: boolean | undefined;
  const unsub = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      streamed += event.assistantMessageEvent.delta;
    }
    if (event.type === "agent_settled") {
      settledAborted = event.aborted;
    }
  });

  const timer = setTimeout(() => {
    console.log("[abort] calling session.abort() after 1500ms; chars so far =", streamed.length);
    session.abort().catch((err: any) => console.log("[abort] abort() rejected:", err?.message ?? err));
  }, 1500);

  let promptRejected: string | undefined;
  let promptResolved = false;
  try {
    await session.prompt("Write a detailed 1000-word essay about the history of espresso coffee.");
    promptResolved = true;
  } catch (err: any) {
    promptRejected = err?.message ?? String(err);
  } finally {
    clearTimeout(timer);
    unsub();
    session.dispose();
  }

  section("results");
  console.log("streamed chars before abort/end =", streamed.length);
  console.log("prompt resolved                 =", promptResolved);
  console.log("prompt rejected                 =", promptRejected ? "yes" : "no");
  if (promptRejected) console.log("prompt rejection message        =", promptRejected);
  console.log("agent_settled.aborted           =", settledAborted);
  console.log(
    "RESULT:",
    settledAborted === true ? "PASS - abort observed via agent_settled" : "PARTIAL - see values above"
  );
}

async function main(): Promise<void> {
  await testBadEndpoint();
  await testAbort();
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
