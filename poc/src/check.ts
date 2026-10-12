import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  AGENT_DIR,
  POC_ROOT,
  MODELS_BAD_PATH,
  OLLAMA_MODEL,
  createRuntime,
} from './common.ts';

async function run() {
  const runtime = await createRuntime(MODELS_BAD_PATH);
  const model = runtime.getModel('ollama-bad', OLLAMA_MODEL);
  const { session } = await createAgentSession({
    cwd: POC_ROOT,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    noTools: 'all',
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });

  const events: any[] = [];
  const unsub = session.subscribe((event: any) => {
    events.push(event);
  });

  try {
    await session.prompt('Say hi');
  } catch (e) {}

  unsub();
  session.dispose();

  let agentEndWillRetry: boolean | undefined;
  let agentEndErrorMsg: string | undefined;
  let autoRetryEndSuccess: boolean | undefined;
  let autoRetryEndError: string | undefined;
  let hasErrorStopReason = false;

  for (const e of events) {
    if (e.type === 'agent_end') {
      agentEndWillRetry = e.willRetry;
      if (e.messages) {
        for (const m of e.messages) {
          if (m.role === 'assistant' && m.stopReason === 'error') hasErrorStopReason = true;
          if (m.role === 'assistant' && m.errorMessage) agentEndErrorMsg = agentEndErrorMsg || m.errorMessage;
        }
      }
      agentEndErrorMsg = agentEndErrorMsg || e.errorMessage;
    }
    if (e.type === 'auto_retry_end') {
      autoRetryEndSuccess = e.success;
      autoRetryEndError = e.finalError;
    }
  }
  console.log(agentEndWillRetry, agentEndErrorMsg, autoRetryEndSuccess, autoRetryEndError, hasErrorStopReason);
}
run();
