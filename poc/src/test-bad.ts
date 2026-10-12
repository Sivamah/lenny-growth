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
  banner,
  section,
} from './common.ts';

async function testBadEndpoint(): Promise<void> {
  banner('PoC 05a - error handling: unreachable baseUrl (http://localhost:59999/v1)');

  const runtime = await createRuntime(MODELS_BAD_PATH);
  const model = runtime.getModel('ollama-bad', OLLAMA_MODEL);
  if (!model) {
    console.log('UNEXPECTED: bad model could not be resolved from runtime');
    return;
  }

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

  let promptError: string | undefined;
  let resolved = false;
  let agentEndWillRetry: boolean | undefined;
  let agentEndError: string | undefined;
  let settledError: any;
  const events: any[] = [];
  const unsub = session.subscribe((event: any) => {
    events.push(event.type);
    if (event.type === 'agent_end') {
      agentEndWillRetry = event.willRetry;
      agentEndError = event.errorMessage;
    }
    if (event.type === 'agent_settled') {
      settledError = event.error;
    }
  });

  try {
    await session.prompt('Say hi');
    resolved = true;
  } catch (err: any) {
    promptError = err?.message ?? String(err);
  } finally {
    unsub();
    session.dispose();
  }

  section('results');
  console.log('prompt resolved unexpectedly =', resolved);
  console.log('error captured (thrown)     =', promptError ? 'yes' : 'no');
  console.log('error message (thrown)       =', promptError);
  console.log('agent_end.willRetry          =', agentEndWillRetry);
  console.log('agent_end.errorMessage       =', agentEndError);
  console.log('agent_settled.error          =', settledError ? (settledError.message || settledError) : 'none');
  console.log('RESULT:', (!resolved && promptError) || agentEndError || settledError ? 'PASS - error surfaced to caller' : 'FAIL - no error surfaced');
}

await testBadEndpoint();
