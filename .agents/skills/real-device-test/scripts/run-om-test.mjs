// OM 实机测试驱动（warm 阶段，参考实现）：从安装的 dist 插件 + mock provider 全链路验证。
// 用法：OM_REPO=<插件仓库绝对路径> node run-om-test.mjs；OM_KEEPALIVE=1 时结束后不关运行时。
// env：OM_PROFILE_DIR（默认脚本所在目录）、OM_PROFILE（默认目录名）、OM_DSH_PKG（默认 npm root -g）、OM_REPO 必填。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { plain, systemText } from './mock-provider.mjs';

const root = process.env.OM_PROFILE_DIR ?? dirname(fileURLToPath(import.meta.url));
const dshPkg =
  process.env.OM_DSH_PKG ??
  join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh', 'package.json');
const REPO = process.env.OM_REPO;
if (!REPO) throw new Error('OM_REPO 必填：插件仓库绝对路径，如 D:/Git/self/dsh-plugin-om');
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
  handles = [],
  handleById = new Map();
const base = {
  omEnabled: true,
  observeThresholdTokens: 1000000,
  reflectThresholdTokens: 1000000,
  tailMessageCount: 0,
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
const askPlugin = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-ask-user')));
async function create(id, extra = {}) {
  const { setup, model, ...rest } = extra;
  const h = await app.agents.create({
    sessionId: id,
    meta: { cwd: REPO },
    agentOptions: { provider: 'mock', model: model ?? 'mock-model' },
    ...rest,
    setup: async (ctx) => {
      await ctx.plugin(askPlugin, { mode: 'legacy' });
      if (setup) await setup(ctx);
    },
  });
  handles.push(h);
  handleById.set(id, h);
  return h.agent;
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
      new Promise(
        (_, r) =>
          (timer = setTimeout(() => r(new Error(`TEST_TIMEOUT ${agent.session.id}`)), timeout)),
      ),
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
const summaries = (a) => typed(a, 'compaction/summary');
const visible = (a) => a.session.surface.nodes.map((s) => a.session.eventAt(s)).filter(Boolean);
// 宿主事件 data 形态：user/message 的 data 即消息本体，其余消息事件为 { message, ... }
const msgOf = (e) => (e.type === 'user/message' ? e.data : e.data?.message);
const surfaceText = (a) => plain(visible(a).map(msgOf).filter(Boolean));
const historyBlocks = (a) =>
  visible(a).filter(
    (e) => e.type === 'user/message' && plain([e.data]).trimStart().startsWith('<history'),
  );
const compCalls = (sid) =>
  adapter.calls.filter((c) => c.purpose === 'compaction' && c.sessionId === sid);
const ordCalls = (sid) =>
  adapter.calls.filter((c) => c.purpose !== 'compaction' && c.sessionId === sid);
const children = (sid) => app.sessions.list().filter((s) => s.header.parentSession === sid);
const recordLabel = (a, childId) =>
  typed(a, 'subagent/catalog')
    .map((e) => e.data)
    .find((d) => d.childId === childId)?.label;
const hist = (sid) => adapter.captures.get(sid)?.hist ?? [];
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('WAIT_TIMEOUT');
    await new Promise((r) => setTimeout(r, 100));
  }
}
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
const exec = (a, line) => app.commands.execute(a, line, [], new AbortController().signal);
try {
  let imm;
  await check('installed dist plugin loads', async () => {
    assert(adapter, 'mock adapter missing');
    entry.fiber.assertActive();
    const providers = await app.llm.listProviders();
    assert(
      providers.some((p) => p.id === 'mock'),
      'mock provider missing',
    );
    const models = await app.llm.listModels('mock');
    assert(
      models.some((m) => m.id === 'claude-mock'),
      'claude-mock missing',
    );
    const installed = `${root}/node_modules/dsh-plugin-om`;
    const versionOf = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;
    assert.equal(versionOf(installed), versionOf(REPO));
    const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);
    const same = hash(`${installed}/dist/index.mjs`) === hash(`${REPO}/dist/index.mjs`);
    assert(same, 'installed dist differs from repo dist');
    assert(
      existsSync(`${installed}/dist/skill/compaction-eval/SKILL.md`),
      'SKILL.md missing in installed dist',
    );
    imm = await create('omtest-imm');
    const names = app.commands.list(imm).map((d) => d.name);
    assert(
      names.includes('om-recompress') && names.includes('om-compaction-eval'),
      `commands missing: ${names.join(',')}`,
    );
    return {
      fiberState: entry.fiber.state,
      distSha256_12: hash(`${installed}/dist/index.mjs`),
      commands: names.filter((n) => n.startsWith('om-')),
    };
  });
  await check('immediate observe + record seed + labels (#111/#108/#112)', async () => {
    await config();
    adapter.modes.set('omtest-imm', 'normal');
    await turn(imm, 'LONG_CASE 首轮详细背景');
    assert(
      ordCalls('omtest-imm')[0].tools.some((t) => t.name === 'recall'),
      'recall tool missing in ordinary request',
    );
    await config({ observeThresholdTokens: 10 });
    const calls = await turn(imm, '次轮继续。');
    assert.equal(compCalls('omtest-imm').length, 3, 'normal flow should take 3 attempts');
    assert.equal(omEv(imm, 'om/observe-pending').length, 1);
    const start = typed(imm, 'compaction/start');
    assert.equal(start.length, 1);
    assert.equal(start[0].data.phase, 'observe');
    const sum = summaries(imm);
    assert.equal(sum.length, 1);
    assert(sum[0].data.usage !== undefined, 'summary usage missing (#108)');
    assert.equal(sum[0].data.provider, 'mock');
    const end = typed(imm, 'compaction/end');
    assert.equal(end.length, 1);
    assert(!end[0].data.error, JSON.stringify(end[0].data.error));
    assert.equal(omEv(imm, 'om/observe-invalidate').length, 1);
    assert.equal(historyBlocks(imm).length, 1);
    const ord = calls.filter((c) => c.purpose !== 'compaction');
    assert(ord.length >= 1);
    assert(
      plain(ord.at(-1).messages).includes('<history'),
      'ordinary request must see history block',
    );
    const kids = children('omtest-imm');
    assert.equal(kids.length, 1);
    assert(kids[0].id.startsWith('om-compaction-log-'));
    const label = recordLabel(imm, kids[0].id);
    assert.match(label, /^OM会话\(\d+-\d+\)-观察$/, `label=${label}`);
    const kev = kids[0].snapshotEvents();
    assert.equal(kev[0].type, 'subagent/descriptor');
    assert(
      kev.some((e) => e.type === 'system/message' && plain([e.data.message]).includes('完整消息')),
      'seed system prompt missing',
    );
    assert(
      kev.some(
        (e) =>
          e.type === 'user/message' &&
          (e.data.source?.kind === 'user' || e.data.message?.source?.kind === 'user'),
      ),
      'task user source missing (#108)',
    );
    assert(
      kev.some((e) => e.type === 'assistant/message' && e.data.usage !== undefined),
      'round usage missing (#108)',
    );
    assert.equal(kids[0].header.origin, 'subagent');
    return { attempts: 3, label, kidEvents: kev.length, summaryUsage: sum[0].data.usage };
  });
  await check('background precompress + delayed injection (#111)', async () => {
    await config({ tailMessageCount: 3 });
    const a = await create('omtest-bg');
    adapter.modes.set('omtest-bg', 'normal');
    await turn(a, 'LONG_CASE 背景');
    await config({ observeThresholdTokens: 10, tailMessageCount: 3 });
    const c2 = await turn(a, '继续B');
    assert(
      c2.some((c) => c.purpose !== 'compaction'),
      'turn2 ordinary request missing',
    );
    assert.equal(omEv(a, 'om/observe-pending').length, 1);
    assert.equal(typed(a, 'compaction/start').length, 0, 'must not inject before due');
    await waitFor(() => omEv(a, 'om/observe-summary').length === 1, 20000);
    assert(compCalls('omtest-bg').length >= 3, 'background job did not run');
    assert.equal(historyBlocks(a).length, 0, 'surface must stay untouched pre-due');
    await turn(a, '继续C');
    assert.equal(typed(a, 'compaction/start').length, 0, 'arrived<tail must not inject');
    const att3 = compCalls('omtest-bg').length;
    await turn(a, '继续D');
    assert.equal(typed(a, 'compaction/start').length, 1);
    assert.equal(summaries(a).length, 1);
    assert.equal(historyBlocks(a).length, 1);
    assert.equal(
      compCalls('omtest-bg').length,
      att3,
      'injection must reuse prepared result, no recompression',
    );
    assert.equal(omEv(a, 'om/observe-invalidate').length, 1);
    const st = surfaceText(a);
    assert(st.includes('继续C') && st.includes('继续D'), 'post-trigger messages must stay visible');
    return { attemptsAfterDue: att3, blocks: 1 };
  });
  await check('cold seed persisted (pending + summary, not injected)', async () => {
    await config({ tailMessageCount: 3 });
    const a = await create('omtest-cold');
    adapter.modes.set('omtest-cold', 'normal');
    await turn(a, 'LONG_CASE 冷恢复背景');
    await config({ observeThresholdTokens: 10, tailMessageCount: 3 });
    await turn(a, '继续B');
    await waitFor(() => omEv(a, 'om/observe-summary').length === 1, 20000);
    assert.equal(typed(a, 'compaction/start').length, 0);
    const h = handleById.get('omtest-cold');
    handles.splice(handles.indexOf(h), 1);
    handleById.delete('omtest-cold');
    await h.dispose();
    return { pending: 1, summary: 1, disposed: true };
  });
  async function ratioSession(sid, mult, expectTrigger) {
    await config({ tailMessageCount: 5 });
    adapter.usageMultiplier.set(sid, mult);
    const a = await create(sid);
    await turn(a, 'LONG_CASE 换算系数背景');
    const m = app.tokenMeter.measure(a.session);
    const sysEst = Math.ceil(systemText(ordCalls(sid).at(-1)).length / 4);
    const netEst = Math.max(1, m.surfaceTokens - sysEst);
    const T = Math.round(netEst * 3);
    await config({ observeThresholdTokens: T, tailMessageCount: 5 });
    await turn(a, '继续第二轮');
    if (expectTrigger) {
      assert.equal(
        omEv(a, 'om/observe-pending').length,
        1,
        `mult=${mult} should trigger at T=${T}`,
      );
      await waitFor(() => omEv(a, 'om/observe-summary').length === 1, 20000);
    } else {
      assert.equal(
        omEv(a, 'om/observe-pending').length,
        0,
        `mult=${mult} must NOT trigger at T=${T}`,
      );
      assert.equal(compCalls(sid).length, 0);
    }
    return {
      surfaceTokens: m.surfaceTokens,
      baseline: m.baseline,
      netEst,
      threshold: T,
      triggered: expectTrigger,
    };
  }
  await check('threshold uses real-token conversion ratio (#109)', async () => {
    const lo = await ratioSession('omtest-ratio-lo', 1, false);
    const hi = await ratioSession('omtest-ratio-hi', 8, true);
    assert.deepEqual([lo.threshold, hi.threshold].sort(), [lo.threshold, hi.threshold].sort());
    return { lo, hi };
  });
  await check('truncation retries then succeeds (#113)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-trunc');
    adapter.modes.set('omtest-trunc', 'truncate-recover');
    await turn(a, 'LONG_CASE 截断背景');
    await config({ observeThresholdTokens: 10 });
    await turn(a, '触发截断恢复');
    const cc = compCalls('omtest-trunc');
    assert.equal(cc.length, 5, `expect 2 truncated + 3 normal attempts, got ${cc.length}`);
    const after = cc[2];
    assert(
      !plain(after.messages).includes('TRUNCATED_OUTPUT_ROUND'),
      'truncated output must not re-enter request',
    );
    assert(
      after.messages.some(
        (m) => m.role === 'user' && plain([m]).includes('上一轮输出因长度上限被截断'),
      ),
      'truncation nudge missing',
    );
    assert.equal(summaries(a).length, 1);
    const kids = children('omtest-trunc');
    assert.equal(kids.length, 1);
    const seedText = plain(
      kids[0]
        .snapshotEvents()
        .filter((e) => e.type === 'assistant/message')
        .map((e) => e.data.message),
    );
    assert(
      seedText.includes('TRUNCATED_OUTPUT_ROUND_1') &&
        seedText.includes('TRUNCATED_OUTPUT_ROUND_2'),
      'truncated rounds must persist to record only',
    );
    return { attempts: cc.length, recordHasTruncated: true };
  });
  await check('truncation failure is atomic (#113)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-truncfail');
    adapter.modes.set('omtest-truncfail', 'truncate-always');
    await turn(a, 'LONG_CASE 失败背景');
    const before = [...a.session.surface.nodes];
    await config({ observeThresholdTokens: 10 });
    const calls = await turn(a, '触发持续截断');
    assert.equal(
      calls.filter((c) => c.purpose !== 'compaction').length,
      0,
      'ordinary request must be blocked',
    );
    assert.equal(compCalls('omtest-truncfail').length, 3);
    assert.equal(summaries(a).length, 0);
    // 后台预压缩失败不进入注入生命周期：无 compaction/start 与 compaction/end，turn 被 pre-step 拒绝
    assert.equal(typed(a, 'compaction/start').length, 0);
    assert.equal(typed(a, 'compaction/end').length, 0);
    const turnEnds = typed(a, 'turn/end');
    assert.equal(
      turnEnds.at(-1).data.reason?.kind,
      'blocked',
      'turn must be blocked by failed compression',
    );
    assert(
      before.every((s) => a.session.surface.nodes.includes(s)),
      'surface must be retained',
    );
    assert.equal(historyBlocks(a).length, 0, 'no history block on failure');
    assert.equal(omEv(a, 'om/observe-pending').length, 1);
    assert.equal(
      omEv(a, 'om/observe-invalidate').length,
      0,
      'pending must stay active after failure',
    );
    const kids = children('omtest-truncfail');
    assert.equal(kids.length, 1);
    const label = recordLabel(a, kids[0].id);
    assert(label.endsWith('-失败'), `label=${label}`);
    const kseed = plain(kids[0].snapshotEvents().map(msgOf).filter(Boolean));
    assert(
      kseed.includes('TRUNCATED_OUTPUT_ROUND_3'),
      'diagnostic child must persist truncated rounds',
    );
    assert(
      kseed.includes('上一轮输出因长度上限被截断'),
      'diagnostic child must persist truncation nudge',
    );
    return { attempts: 3, label, turnBlocked: true };
  });
  for (const [mode, sid] of [
    ['transient-recover', 'omtest-trans'],
    ['5xx-recover', 'omtest-5xx'],
  ])
    await check(`transient retry succeeds (${mode}) (#109)`, async () => {
      await config({ observeThresholdTokens: 1000000 });
      const a = await create(sid);
      adapter.modes.set(sid, mode);
      await turn(a, 'LONG_CASE 瞬时失败背景');
      await config({ observeThresholdTokens: 10 });
      await turn(a, '触发瞬时失败恢复');
      assert.equal(compCalls(sid).length, 4, 'expect 1 failed + 3 normal attempts');
      assert.equal(summaries(a).length, 1);
      assert.equal(typed(a, 'compaction/end')[0].data.error, undefined);
      return { attempts: 4 };
    });
  await check('getHistory reflects current state (#110)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-state');
    adapter.modes.set('omtest-state', 'state-check');
    await turn(a, '第一轮说明');
    await turn(a, '第二轮说明');
    await turn(a, '第三轮说明');
    await config({ observeThresholdTokens: 10 });
    await turn(a, '触发状态验证');
    const h = hist('omtest-state');
    assert(h.length >= 2, `need two getHistory captures, got ${h.length}`);
    assert(
      h[0].includes('ASSIST_TEXT_1') && h[0].includes('ASSIST_TEXT_2'),
      'first view must show originals',
    );
    assert(h[1].includes('SUMMARY_MARKER_A'), 'second view must show submitted summary');
    assert(!h[1].includes('ASSIST_TEXT_1'), 'replaced entry must disappear from current state');
    assert(h[1].includes('ASSIST_TEXT_2'), 'unrelated entry must remain');
    const finalText = String(summaries(a).at(-1).data.summary[0].text);
    assert(
      finalText.includes('SUMMARY_MARKER_A') && !finalText.includes('ASSIST_TEXT_1'),
      'final block must use current state',
    );
    assert.equal(compCalls('omtest-state').length, 3);
    return { views: h.length };
  });
  await check('toolcall entry without callId (#107)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-callid');
    await turn(a, 'RECALL_CASE 检索历史');
    const tr = typed(a, 'tool/result');
    assert(tr.length >= 1 && !tr[0].data.message.isError, 'recall call failed');
    await turn(a, '中间轮');
    await config({ observeThresholdTokens: 10 });
    await turn(a, '触发压缩');
    const h0 = hist('omtest-callid')[0];
    assert(h0, 'no getHistory capture');
    assert.match(h0, /<assistant index="\d+" type="toolcall" tool-name="recall">/);
    assert(
      h0.includes('<tool-args>') && h0.includes('<tool-result>'),
      'toolcall structure missing',
    );
    assert(!h0.includes('callId'), 'callId must not be rendered');
    assert(!/id="mock-/.test(h0), 'raw call id must not leak');
    return { toolcallRendered: true };
  });
  await check('compressSkipReasoning on/off (#105)', async () => {
    await config({ observeThresholdTokens: 1000000, compressSkipReasoning: true });
    const s = await create('omtest-skip-r');
    await turn(s, 'REASON_CASE 第一段');
    await config({ observeThresholdTokens: 10, compressSkipReasoning: true });
    await turn(s, '触发跳过思考');
    const hSkip = hist('omtest-skip-r')[0];
    assert(
      hSkip && !hSkip.includes('<reasoning') && !hSkip.includes('REASONING_MARKER'),
      'reasoning must be skipped',
    );
    assert(hSkip.includes('REASON_REPLY_1'), 'assistant text must remain');
    await config({ observeThresholdTokens: 1000000, compressSkipReasoning: false });
    const k = await create('omtest-keep-r');
    await turn(k, 'REASON_CASE 第一段');
    await config({ observeThresholdTokens: 10, compressSkipReasoning: false });
    await turn(k, '触发保留思考');
    const hKeep = hist('omtest-keep-r')[0];
    assert(
      hKeep?.includes('<reasoning') && hKeep.includes('REASONING_MARKER_1'),
      'reasoning must be kept',
    );
    return { skipped: !hSkip.includes('reasoning'), kept: hKeep.includes('reasoning') };
  });
  async function reasonStrip(sid, model, expectStripped) {
    await config({ observeThresholdTokens: 1000000, tailMessageCount: 1 });
    const a = await create(sid, { model });
    await turn(a, 'REASON_CASE 一');
    await config({ observeThresholdTokens: 10, tailMessageCount: 1 });
    await turn(a, 'REASON_CASE 二');
    await waitFor(() => omEv(a, 'om/observe-summary').length === 1, 20000);
    const attBefore = compCalls(sid).length;
    const calls = await turn(a, '继续三');
    assert.equal(historyBlocks(a).length, 1, 'due injection missing');
    assert.equal(compCalls(sid).length, attBefore, 'injection must not recompress');
    const req = calls.filter((c) => c.purpose !== 'compaction').at(-1);
    const all = plain(req.messages);
    const a2 = req.messages.find(
      (m) => m.role === 'assistant' && plain([m]).includes('REASON_REPLY_2'),
    );
    assert(a2, 'stale assistant text must remain in request');
    const hasReasoning = (a2.content ?? []).some((b) => b.type === 'reasoning');
    if (expectStripped) {
      assert(!hasReasoning, 'stale signed reasoning must be stripped');
      assert(
        !all.includes('REASONING_MARKER_2') && !all.includes(`SIG_${sid}`),
        'signature/reasoning leaked',
      );
      // 边界之后新产生的签名思考必须原样保留（插件只剥离陈旧签名思考）
      await config({ observeThresholdTokens: 1000000 });
      await turn(a, 'REASON_CASE 四');
      const calls5 = await turn(a, '继续五');
      const req5 = calls5.filter((c) => c.purpose !== 'compaction').at(-1);
      const a4 = req5.messages.find(
        (m) => m.role === 'assistant' && plain([m]).includes('REASON_REPLY_4'),
      );
      assert(a4, 'fresh assistant missing in replay');
      assert(
        (a4.content ?? []).some((b) => b.type === 'reasoning'),
        'fresh signed reasoning must be preserved',
      );
      assert(JSON.stringify(a4).includes(`SIG_${sid}`), 'fresh signature must be preserved');
    } else {
      // 无签名会话：reasoning 块未被宿主标记为 Anthropic 签名，插件不得剥离
      assert(hasReasoning, 'unsigned reasoning must be preserved');
      const rText = (a2.content ?? [])
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('');
      assert(rText.includes('REASONING_MARKER_2'), 'unsigned reasoning text must remain');
      assert(all.includes('REASON_REPLY_2'), 'unsigned replay text must remain');
    }
    return { stripped: expectStripped, attempts: attBefore };
  }
  await check(
    'stale Claude thinking stripped from replay (#101)',
    async () => await reasonStrip('omtest-claude', 'claude-mock', true),
  );
  await check(
    'unsigned reasoning preserved (control)',
    async () => await reasonStrip('omtest-nosig', 'mock-model', false),
  );
  await check('reflect merges history blocks (#112/#94)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-reflect');
    await turn(a, 'LONG_CASE 第一段');
    await config({ observeThresholdTokens: 200 });
    await turn(a, '继续二');
    assert.equal(historyBlocks(a).length, 1);
    await turn(a, 'LONG_CASE 第二段');
    const blocksBefore = historyBlocks(a).length;
    assert(blocksBefore >= 2, `need two blocks before reflect, got ${blocksBefore}`);
    const sumsBefore = summaries(a).length;
    await config({ observeThresholdTokens: 1000000, reflectThresholdTokens: 1 });
    const calls = await turn(a, '触发反思合并');
    const cc = calls.filter((c) => c.purpose === 'compaction');
    assert(cc.length >= 3, 'reflect loop missing');
    assert(
      cc.some((c) => plain(c.messages).includes('合并压缩全部')),
      'reflect task text missing',
    );
    assert(
      cc.every((c) => !c.tools.some((t) => t.name === 'rewriteAskUserQuestion')),
      'reflect must not offer rewrite tool',
    );
    assert.equal(historyBlocks(a).length, 1, 'blocks must merge into one');
    const start = typed(a, 'compaction/start');
    assert.equal(start.at(-1).data.phase, 'reflect');
    assert.equal(summaries(a).length, sumsBefore + 1);
    const labels = children('omtest-reflect').map((k) => recordLabel(a, k.id));
    assert(
      labels.some((l) => l && /^OM会话\(\d+-\d+\)-反思$/.test(l)),
      `reflect label missing: ${JSON.stringify(labels)}`,
    );
    return { labels };
  });
  await check('recompress command matrix (#94)', async () => {
    const id = String(typed(imm, 'compaction/start')[0].data.compactionId);
    let r = await exec(imm, '/om-recompress');
    assert.equal(r.result.kind, 'error');
    assert(r.result.text.startsWith('用法：/om-recompress'), r.result.text);
    r = await exec(imm, '/om-recompress nonexistent mock mock-model');
    assert(r.result.text.includes('未找到压缩'), r.result.text);
    // 失败的反思压缩：start(reflect) + end(error) 已落盘但无 summary → 未成功完成
    await config({ observeThresholdTokens: 1000000, reflectThresholdTokens: 1000000 });
    const rf = await create('omtest-rfail');
    adapter.modes.set('omtest-rfail', 'normal');
    await turn(rf, 'LONG_CASE 反思失败背景');
    await config({ observeThresholdTokens: 10 });
    await turn(rf, '注入一块历史');
    assert.equal(summaries(rf).length, 1, 'rfail needs one injected block first');
    adapter.modes.set('omtest-rfail', 'failure');
    await config({ observeThresholdTokens: 1000000, reflectThresholdTokens: 1 });
    await turn(rf, '触发反思失败');
    const rfStart = typed(rf, 'compaction/start').at(-1);
    assert.equal(rfStart.data.phase, 'reflect');
    const rfEnd = typed(rf, 'compaction/end').at(-1);
    assert(rfEnd.data.error !== undefined, 'failed reflect must append end(error)');
    assert.equal(summaries(rf).length, 1, 'failed reflect must not add summary');
    const rfId = String(rfStart.data.compactionId);
    r = await exec(rf, `/om-recompress ${rfId} mock mock-model`);
    assert(r.result.text.includes('未成功完成'), r.result.text);
    adapter.modes.set('omtest-rfail', 'normal');
    await config({ observeThresholdTokens: 1000000, reflectThresholdTokens: 1000000 });
    const before = summaries(imm).length,
      nodesBefore = [...imm.session.surface.nodes];
    r = await exec(imm, `/om-recompress ${id} mock claude-mock low`);
    assert.equal(r.result.kind, 'success', JSON.stringify(r.result));
    assert(r.result.text.startsWith('重压缩完成 字符'), r.result.text);
    const lastcc = compCalls('omtest-imm').at(-1);
    assert.equal(lastcc.model, 'claude-mock');
    assert.equal(lastcc.reasoningEffort, 'low');
    assert.equal(summaries(imm).length, before, 'main session must not gain summary');
    assert.deepEqual([...imm.session.surface.nodes], nodesBefore, 'surface must not change');
    const labels = children('omtest-imm').map((k) => recordLabel(imm, k.id));
    assert(
      labels.some((l) => l?.endsWith('-观察-重压缩')),
      `recompress label missing: ${JSON.stringify(labels)}`,
    );
    await config({ recompressConcurrency: 1 });
    const att0 = compCalls('omtest-imm').length;
    const [r1, r2] = await Promise.all([
      exec(imm, `/om-recompress ${id} mock mock-model`),
      exec(imm, `/om-recompress ${id} mock mock-model`),
    ]);
    assert.equal(r1.result.kind, 'success');
    assert.equal(r2.result.kind, 'success');
    assert.equal(
      compCalls('omtest-imm').length - att0,
      6,
      `queued recompress attempts=${compCalls('omtest-imm').length - att0}`,
    );
    await config();
    return { successText: r.result.text, concurrencyOk: true };
  });
  await check('compaction eval command (#102/#104/#106)', async () => {
    let r = await exec(imm, '/om-compaction-eval a b c');
    assert.equal(r.result.kind, 'error');
    assert.equal(r.result.text, '用法：/om-compaction-eval [provider/model [思考等级]]');
    r = await exec(imm, '/om-compaction-eval');
    assert.equal(r.result.kind, 'success', JSON.stringify(r.result));
    assert(r.result.text.startsWith('已启动 OM 结果分析会话 '), r.result.text);
    const id1 = r.result.text.slice('已启动 OM 结果分析会话 '.length).trim();
    const s1 = await waitFor(() => app.sessions.list().find((s) => s.id === id1), 10000);
    assert.equal(s1.header.cwd, REPO);
    const firstUser = await waitFor(
      () => s1.snapshotEvents().find((e) => e.type === 'user/message'),
      10000,
    );
    assert(firstUser, 'eval session user/message missing');
    const text = plain([firstUser.data]);
    assert(text.startsWith('按照 '), text.slice(0, 80));
    assert(
      text
        .replace(/\\/g, '/')
        .includes('node_modules/dsh-plugin-om/dist/skill/compaction-eval/SKILL.md'),
      `must use installed dist SKILL.md: ${text.slice(0, 120)}`,
    );
    assert(text.includes('session_id omtest-imm'));
    await waitFor(
      () => adapter.calls.some((c) => c.sessionId === id1 && c.purpose !== 'compaction'),
      15000,
    );
    r = await exec(imm, '/om-compaction-eval mock/claude-mock low');
    assert.equal(r.result.kind, 'success', JSON.stringify(r.result));
    const id2 = r.result.text.slice('已启动 OM 结果分析会话 '.length).trim();
    await waitFor(
      () =>
        adapter.calls.some(
          (c) => c.sessionId === id2 && c.model === 'claude-mock' && c.reasoningEffort === 'low',
        ),
      15000,
    );
    const ch = await create('omtest-evalchild', {
      parentAgent: imm,
      meta: { cwd: REPO, parentSession: 'omtest-imm', origin: 'subagent', delegationDepth: 1 },
    });
    r = await exec(ch, '/om-compaction-eval');
    assert.equal(r.result.kind, 'error');
    assert(r.result.text.includes('仅支持主会话'), r.result.text);
    return { evalSessions: [id1, id2], modelSelect: 'claude-mock/low' };
  });
  await check('ask rewrite regression (#101 前基线)', async () => {
    await config();
    const a = await create('omtest-rewrite');
    adapter.modes.set('omtest-rewrite', 'rewrite');
    await turn(a, 'ASK_CASE 进行真实宿主问答');
    assert(typed(a, 'tool/result').length >= 1);
    await config({ observeThresholdTokens: 10 });
    const calls = await turn(a, '压缩问答后继续');
    const cc = calls.filter((c) => c.purpose === 'compaction');
    assert(cc.length >= 2);
    assert(
      cc.some((c) => c.tools.some((t) => t.name === 'rewriteAskUserQuestion')),
      'rewrite tool missing',
    );
    const kids = children('omtest-rewrite');
    const kev = kids.flatMap((k) => k.snapshotEvents());
    const toolResults = kev.filter((e) => e.type === 'tool/result').map((e) => e.data.message);
    assert(
      toolResults.some((m) => m.isError && plain([m]).includes('全部 3 题')),
      'question-count guard missing',
    );
    assert(
      toolResults.some((m) => m.isError && plain([m]).includes('不要提交 options')),
      'options guard missing',
    );
    assert(
      toolResults.some((m) => m.isError && plain([m]).includes('尚未处理原始 ask')),
      'complete-before-rewrite guard missing',
    );
    const terminal = kev.filter((e) => e.type === 'tool/result').at(-1).data;
    assert.equal(terminal.error?.code, 'TOOL_NOT_STARTED');
    const nextText = plain(calls.filter((c) => c.purpose !== 'compaction').at(-1).messages);
    // XML 序列化会转义字面值，还原后再断言特殊字符保真
    const unescaped = nextText
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    assert(
      nextText.includes('<ask-user-question') &&
        unescaped.includes('不上传数据，离线运行') &&
        unescaped.includes('a:(未回答)') &&
        unescaped.includes('<xml> &') &&
        unescaped.includes(']]>') &&
        !unescaped.includes('o1:'),
      'rewritten ask missing in replay',
    );
    return { compressionRequests: cc.length };
  });
  await check('manual skill counts as complete message (#99)', async () => {
    await config({ observeThresholdTokens: 1000000 });
    const a = await create('omtest-skill');
    await turn(a, '第一段工作');
    a.session.append(
      'user/message',
      createUserMessage({
        content: [
          {
            type: 'text',
            text: '<skill_content name="demo-skill"><skill_resources>DEMO_RESOURCES</skill_resources><skill_instructions>DEMO_SKILL_BODY 指令正文</skill_instructions></skill_content>',
          },
        ],
        source: { kind: 'skill-invocation', name: 'demo-skill' },
      }),
      { surfaceOp: 'append' },
    );
    await turn(a, '第二段工作');
    await config({ observeThresholdTokens: 10 });
    await turn(a, '触发压缩');
    const h0 = hist('omtest-skill')[0];
    assert(h0, 'no view captured');
    assert(
      h0.includes('<skill_content name="demo-skill"') && h0.includes('DEMO_SKILL_BODY'),
      'skill content missing from view',
    );
    const m = /<skill_content[^>]*index="(\d+)"/.exec(h0);
    assert(m, 'skill entry without index');
    assert.equal(m[1], '2', 'skill must occupy complete-message slot 2 (u1,a1,skill)');
    assert.equal(summaries(a).length, 1);
    const finalText = String(summaries(a).at(-1).data.summary[0].text);
    assert(finalText.includes('demo-skill'), 'skill entry must persist in final block');
    assert.equal(compCalls('omtest-skill').length, 3);
    return { skillIndex: m[1] };
  });
  await config();
  writeFileSync(`${root}/warm-results.json`, JSON.stringify(results, null, 2));
  const dump = app.sessions.list().map((s) => ({
    id: s.id,
    origin: s.header.origin,
    events: s.snapshotEvents().map((e) => e.type),
  }));
  writeFileSync(`${root}/warm-sessions.json`, JSON.stringify(dump, null, 1));
  console.log(
    'OM_TEST_DONE',
    JSON.stringify({
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
    }),
  );
  if (process.env.OM_KEEPALIVE === '1') {
    console.log('TEST_PROFILE_BROWSER_READY');
  } else {
    for (const h of handles.reverse()) await h.dispose();
    await runtime.shutdown.shutdown(results.some((r) => r.status === 'FAIL') ? 1 : 0);
  }
} catch (e) {
  console.error(e);
  writeFileSync(`${root}/fatal.txt`, e.stack);
  writeFileSync(`${root}/warm-results.json`, JSON.stringify(results, null, 2));
  await runtime.shutdown.shutdown(1);
}
