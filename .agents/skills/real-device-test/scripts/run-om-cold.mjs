// OM 实机测试驱动（cold 阶段，参考实现）：重启后直接采纳持久化 om/observe-summary，不重压缩。
// 前置：warm 阶段已产出 omtest-cold（pending + summary 信封已落盘、未注入）。
// 用法：node run-om-cold.mjs；env 覆盖同 run-om-test.mjs（OM_PROFILE_DIR / OM_PROFILE / OM_DSH_PKG）。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { plain } from './mock-provider.mjs';

const root = process.env.OM_PROFILE_DIR ?? dirname(fileURLToPath(import.meta.url));
const dshPkg =
  process.env.OM_DSH_PKG ??
  join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh', 'package.json');
const require = createRequire(dshPkg);
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { createLaunchEnvironmentSnapshot } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment'))
);
const { runProfile } = await import(pathToFileURL(join(dirname(dshPkg), 'lib', 'profile-boot.js')));
process.env.DSH_PROFILE = process.env.OM_PROFILE ?? basename(root);
process.env.DSH_PROFILE_DIR = root;
process.env.DSH_TELEMETRY_DISABLED = '1';
const runtime = await runProfile({
  profile: process.env.DSH_PROFILE,
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
});
const app = runtime.ctx,
  adapter = app.get('omTestMock'),
  entry = [...app.loader.entries()].find((e) => e.options.name === 'dsh-plugin-om');
const results = [],
  handles = [];
const base = {
  omEnabled: true,
  observeThresholdTokens: 1000000,
  reflectThresholdTokens: 1000000,
  tailMessageCount: 3,
  rateLimitWaitMs: 0,
  semanticRecallEnabled: false,
  recallEnabled: true,
  debug: true,
  compressSkipReasoning: false,
};
async function config(p = {}) {
  await entry.update({ config: { ...base, ...p } });
  await app.loader.await();
  entry.fiber.assertActive();
}
async function turn(agent, text, timeout = 25000) {
  const n = adapter.calls.length;
  agent.followup(
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  );
  let timer;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, r) => (timer = setTimeout(() => r(new Error('TEST_TIMEOUT')), timeout))),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const calls = adapter.calls.slice(n);
  assert(
    calls.every((c) => c.provider === 'mock'),
    'non-mock request escaped',
  );
  return calls;
}
const ev = (a) => a.session.snapshotEvents();
// om 私有事件是 ignorable 的 plugin record：类型 plugin:dsh-plugin-om/<名>，载荷即 e.data
const omRecordType = (kind) => `plugin:dsh-plugin-om/${kind.replace(/^om\//, '')}`;
const omEv = (a, kind) =>
  ev(a).filter((e) => e.ignorable === true && e.type === omRecordType(kind));
const typed = (a, t) => ev(a).filter((e) => e.type === t);
const msgOf = (e) => (e.type === 'user/message' ? e.data : e.data.message);
const visible = (a) => a.session.surface.nodes.map((s) => a.session.eventAt(s)).filter(Boolean);
const surfaceText = (a) => plain(visible(a).map(msgOf).filter(Boolean));
const historyBlocks = (a) =>
  visible(a).filter(
    (e) =>
      e.type === 'user/message' &&
      plain([msgOf(e)])
        .trimStart()
        .startsWith('<history'),
  );
const compCalls = (sid) =>
  adapter.calls.filter((c) => c.purpose === 'compaction' && c.sessionId === sid);
async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, status: 'PASS', detail });
    console.log('PASS', label, JSON.stringify(detail));
  } catch (e) {
    results.push({ label, status: 'FAIL', error: e.stack });
    console.error('FAIL', label, e?.stack ?? e);
  }
}
try {
  await config();
  await check(
    'cold adoption: persisted summary injected without recompression (#111)',
    async () => {
      const h = await app.agents.resume({
        resumeSessionId: 'omtest-cold',
        agentOptions: { provider: 'mock', model: 'mock-model' },
      });
      handles.push(h);
      const a = h.agent;
      assert.equal(omEv(a, 'om/observe-pending').length, 1, 'pending marker must survive restart');
      assert.equal(
        omEv(a, 'om/observe-summary').length,
        1,
        'summary envelope must survive restart',
      );
      assert.equal(historyBlocks(a).length, 0, 'must not be injected yet');
      const c1 = await turn(a, '继续C');
      assert(
        c1.some((c) => c.purpose !== 'compaction'),
        'ordinary request missing',
      );
      // 到期语义含本轮新消息（落盘 2 + 本轮 1 = 3 ≥ tail=3），继续C 轮即到期采纳注入；
      // 核心断言：冷启动全程零压缩请求，直接采纳 warm 落盘的 summary
      assert.equal(compCalls('omtest-cold').length, 0, 'cold must not recompress');
      assert.equal(
        typed(a, 'compaction/start').length,
        1,
        'adoption injection must run exactly once',
      );
      const sum = typed(a, 'compaction/summary');
      assert.equal(sum.length, 1);
      assert.equal(sum[0].data.provider, 'mock', 'adopted summary keeps original provider');
      assert.equal(historyBlocks(a).length, 1);
      assert.equal(omEv(a, 'om/observe-invalidate').length, 1);
      const end = typed(a, 'compaction/end');
      assert.equal(end.length, 1);
      assert(!end[0].data.error, JSON.stringify(end[0].data.error));
      assert(end[0].data.diagnosticSessionId, 'adopted end keeps warm diagnostic session');
      const st = surfaceText(a);
      assert(st.includes('继续C'), 'post-trigger message must stay visible');
      assert(
        plain(c1.filter((c) => c.purpose !== 'compaction').at(-1).messages).includes('<history'),
      );
      return { coldCompactionRequests: 0, injected: true, diagnosticReused: true };
    },
  );
  writeFileSync(`${root}/cold-results.json`, JSON.stringify(results, null, 2));
  console.log(
    'OM_COLD_DONE',
    JSON.stringify({
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
    }),
  );
  for (const h of handles.reverse()) await h.dispose();
  await runtime.shutdown.shutdown(results.some((r) => r.status === 'FAIL') ? 1 : 0);
} catch (e) {
  console.error(e);
  writeFileSync(`${root}/cold-fatal.txt`, e.stack);
  writeFileSync(`${root}/cold-results.json`, JSON.stringify(results, null, 2));
  await runtime.shutdown.shutdown(1);
}
