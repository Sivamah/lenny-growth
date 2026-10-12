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
} catch (e) {
  // ignore
}

unsub();
session.dispose();

const agentEnd = events.find(e => e.type === 'agent_end');
const autoRetryEnd = events.find(e => e.type === 'auto_retry_end');
const agentSettled = events.find(e => e.type === 'agent_settled');
console.log('hasAgentEnd:', !!agentEnd);
console.log('agentEnd:', agentEnd);
console.log('autoRetryEnd:', autoRetryEnd);
console.log('agentSettled:', agentSettled);
