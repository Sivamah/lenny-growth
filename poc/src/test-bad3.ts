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

let err: any;
try {
  await session.prompt('Say hi');
} catch (e) {
  err = e;
} finally {
  unsub();
  session.dispose();
}

const last = events[events.length - 1];
console.log('thrown:', err ? (err.message || err) : 'none');
console.log('lastType:', last?.type);
console.log('lastErr:', last?.finalError || last?.errorMessage || last?.error || 'none');
console.log('willRetry:', last?.willRetry);
