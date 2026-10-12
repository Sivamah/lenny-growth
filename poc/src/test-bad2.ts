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

try {
  await session.prompt('Say hi');
} catch (err: any) {
  console.log('ERR:', err?.message);
} finally {
  unsub();
  session.dispose();
}

for (let i = events.length - 30; i < events.length; i++) {
  if (i < 0) continue;
  const e = events[i];
  console.log(i + ':', e.type, e.finalError || e.errorMessage || '');
}
