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
}

unsub();
session.dispose();

let ae: any, are: any, as: any;
for (const e of events) {
  if (e.type === 'agent_end') ae = e;
  if (e.type === 'auto_retry_end') are = e;
  if (e.type === 'agent_settled') as = e;
}
console.log('AE:', ae ? {willRetry: ae.willRetry, err: ae.errorMessage} : 'none');
if (ae?.messages) {
  for (const m of ae.messages) {
    if (m.role === 'assistant') console.log('ASS:', m.stopReason, m.errorMessage);
  }
}
console.log('ARE:', are);
console.log('AS:', as);
