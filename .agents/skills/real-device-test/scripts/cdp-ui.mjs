// OM 浏览器实测 CDP 驱动（参考实现）：连接专用 Chrome（普通模式），提供 openTab/ev/screenshot。
// 用法：node cdp-ui.mjs <step>，step 为脚本内定义的用例名。
// env：OM_CDP_PORT（默认 9334）、OM_GUI_URL 或 OM_GUI_PORT+OM_GUI_TOKEN、OM_PROFILE_DIR、OM_SHOT_DIR、OM_REPO（regws 用）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = `http://127.0.0.1:${process.env.OM_CDP_PORT ?? '9334'}`;
const GUI =
  process.env.OM_GUI_URL ??
  `http://127.0.0.1:${process.env.OM_GUI_PORT ?? '3210'}/?token=${process.env.OM_GUI_TOKEN ?? ''}`;
const SHOT_DIR =
  process.env.OM_SHOT_DIR ??
  join(process.env.OM_PROFILE_DIR ?? dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

async function newTab(url) {
  const r = await fetch(`${CDP_HTTP}/json/new?url=${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}
async function listTabs() {
  return (await fetch(`${CDP_HTTP}/json/list`)).json();
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (m.method === 'Page.javascriptDialogOpening')
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        `EVAL: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
    return name;
  }
}

async function connect(url) {
  const log = (m) => process.stderr.write(`[connect] ${m}\n`);
  const tabs = await listTabs();
  log(`tabs=${tabs.length}`);
  // 先开新 tab 再关旧 page：关光所有 page 会让 Chrome 退出；不关则积压 tab 拖慢 CDP
  const tab = await newTab('about:blank');
  log(`newTab id=${tab.id}`);
  for (const t of tabs.filter((x) => x.type === 'page' && x.id !== tab.id))
    await fetch(`${CDP_HTTP}/json/close/${t.id}`).catch(() => {});
  log('closed');
  await new Promise((r) => setTimeout(r, 500));
  let target;
  for (let i = 0; i < 40; i++) {
    const all = await listTabs();
    target = all.find((t) => t.id === tab.id && t.webSocketDebuggerUrl);
    if (target) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('no ws target');
  log('ws url ok');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
    setTimeout(() => j(new Error('ws open timeout')), 8000);
  });
  log('ws open');
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  log('enabled');
  await page.send('Page.navigate', { url });
  log('navigated');
  return page;
}

async function waitLoad(page, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await page.ev('document.readyState').catch(() => 'loading');
    if (st === 'complete') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('page load timeout');
}

// —— 交互 helper（在页面内执行）——
const clickByText = (sel, text) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const t = el => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const hit = els.find(el => t(el).includes(${JSON.stringify(text)}));
  if (!hit) return 'NOT_FOUND:' + ${JSON.stringify(text)};
  hit.click(); return 'CLICKED:' + t(hit).slice(0, 40);
})()`;

const dumpText = `(() => document.body.innerText.slice(0, 3000))()`;

// —— 探索步骤：截图 + 结构概览 ——
async function explore() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3000));
  const info = await page.ev(`(() => {
    const q = s => [...document.querySelectorAll(s)];
    return {
      title: document.title,
      url: location.href.slice(0, 60),
      bodyText: document.body.innerText.slice(0, 800),
      buttons: q('button').map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)).filter(Boolean).slice(0, 40),
      inputs: q('input,textarea,[contenteditable="true"]').map(i => i.tagName + ':' + (i.getAttribute('placeholder') || i.getAttribute('aria-label') || i.className.slice(0, 40))).slice(0, 20),
      links: q('a').map(a => (a.textContent || '').trim().slice(0, 30)).filter(Boolean).slice(0, 40),
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await page.shot('explore-home');
  process.exit(0);
}

// —— 侧边栏与工作区探索 ——
async function sidebar() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('open-sidebar:', await page.ev(clickByText('button', '打开侧边栏')));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after-open:', JSON.stringify((await page.ev(dumpText)).slice(0, 1500)));
  await page.shot('explore-sidebar');
  process.exit(0);
}

// —— 搜索会话 ——
async function search() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('open-sidebar:', await page.ev(clickByText('button', '打开侧边栏')));
  await new Promise((r) => setTimeout(r, 1000));
  console.log('search-btn:', await page.ev(clickByText('button', '搜索会话')));
  await new Promise((r) => setTimeout(r, 1200));
  const inputs = await page.ev(
    `(() => [...document.querySelectorAll('input,textarea')].map((i, n) => n + ':' + i.tagName + ':' + (i.placeholder || i.getAttribute('aria-label') || '') + ':' + (i.offsetParent ? 'visible' : 'hidden')).join(' | '))()`,
  );
  console.log('inputs:', inputs);
  await page.shot('explore-search');
  process.exit(0);
}

// React 受控 input 赋值 helper（页面内执行）
const setInput = (placeholder, value) => `(() => {
  const el = [...document.querySelectorAll('input')].find(i => (i.placeholder || '') === ${JSON.stringify(placeholder)});
  if (!el) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'SET';
})()`;

// —— 列出搜索结果 ——
async function sessions() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 800));
  await page.ev(clickByText('button', '搜索会话'));
  await new Promise((r) => setTimeout(r, 1000));
  console.log('set:', await page.ev(setInput('搜索会话名称', 'omtest')));
  await new Promise((r) => setTimeout(r, 5000));
  const results = await page.ev(`(() => {
    const aside = document.querySelector('aside') || document.body;
    return aside.innerText.slice(0, 2500);
  })()`);
  console.log('results:', JSON.stringify(results));
  await page.shot('explore-results');
  process.exit(0);
}

async function dbg() {
  console.log('list...');
  const tabs = await listTabs();
  console.log('tabs:', tabs.length);
  const target = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  console.log('target:', target?.url?.slice(0, 50), target?.webSocketDebuggerUrl?.slice(0, 60));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', (_e) => j(new Error('ws error')));
    setTimeout(() => j(new Error('ws open timeout')), 8000);
  });
  console.log('ws open');
  const page = new Page(ws);
  console.log('runtime.enable...');
  await page.send('Runtime.enable');
  console.log('page.enable...');
  await page.send('Page.enable');
  console.log('navigate...');
  await page.send('Page.navigate', { url: GUI });
  console.log('navigated');
  await new Promise((r) => setTimeout(r, 4000));
  console.log('readyState:', await page.ev('document.readyState'));
  console.log('title:', await page.ev('document.title'));
  process.exit(0);
}

// —— 添加工作区弹窗探索 ——
async function addws() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('click:', await page.ev(clickByText('button', '添加工作区')));
  await new Promise((r) => setTimeout(r, 1500));
  const dump = await page.ev(`(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog')].pop() || document.body;
    return {
      text: dlg.innerText.slice(0, 800),
      inputs: [...dlg.querySelectorAll('input')].map(i => (i.placeholder || i.type || '') + ':' + (i.offsetParent ? 'vis' : 'hid')),
      buttons: [...dlg.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)),
    };
  })()`);
  console.log(JSON.stringify(dump, null, 1));
  await page.shot('explore-addws');
  process.exit(0);
}

// —— 注册工作区：向隐藏 file input 注入目录 ——
async function regws() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: -1 });
  const node = await page.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!node.nodeId) throw new Error('no file input');
  await page.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [process.env.OM_REPO] });
  console.log('files set');
  await new Promise((r) => setTimeout(r, 4000));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 1500));
  const dump = await page.ev(`(() => {
    const aside = document.querySelector('aside') || document.body;
    return aside.innerText.slice(0, 1200);
  })()`);
  console.log('sidebar:', JSON.stringify(dump));
  await page.shot('regws');
  process.exit(0);
}

// —— 侧边栏元素探索 + 点工作区 ——
async function wsclick() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 1200));
  const els = await page.ev(`(() => {
    const out = [];
    document.querySelectorAll('aside *, [class*="sidebar"] *').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && el.children.length === 0) out.push(el.tagName + '|' + (el.getAttribute('aria-label') || '') + '|' + t);
    });
    return [...new Set(out)].join('\\n');
  })()`);
  console.log(`leaf elements:\n${els}`);
  await page.shot('wsclick-1');
  // 点击侧边栏「工作区」导航入口（SPAN 的最近可点祖先）
  const clicked = await page.ev(`(() => {
    const spans = [...document.querySelectorAll('span')].filter(s => (s.textContent || '').trim() === '工作区');
    if (!spans.length) return 'NO_CANDIDATE';
    let el = spans[0];
    for (let i = 0; i < 6 && el; i++) {
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'treeitem') break;
      el = el.parentElement;
    }
    (el || spans[0]).click();
    return 'CLICKED:' + (el || spans[0]).tagName;
  })()`);
  console.log('click:', clicked);
  await new Promise((r) => setTimeout(r, 2000));
  const after = await page.ev(`(() => document.body.innerText.slice(0, 1500))()`);
  console.log('after:', JSON.stringify(after));
  await page.shot('wsclick-2');
  process.exit(0);
}

// —— 主区「选择工作区」下拉探索 ——
async function wsdrop() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('click:', await page.ev(clickByText('button', '选择工作区')));
  await new Promise((r) => setTimeout(r, 1500));
  const dump = await page.ev(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[class*="popover"],[class*="dropdown"]')];
    return JSON.stringify({
      menuCount: menus.length,
      menuTexts: menus.map(m => (m.innerText || '').slice(0, 300)),
      bodyTail: document.body.innerText.slice(-600),
    });
  })()`);
  console.log('dump:', dump);
  await page.shot('wsdrop');
  process.exit(0);
}

// —— 主区下拉选择工作区 ——
async function wsselect() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '选择工作区'));
  await new Promise((r) => setTimeout(r, 1500));
  const box = await page.ev(`(() => {
    const items = [...document.querySelectorAll('[role="menu"] *, [role="listbox"] *, [data-radix-popper-content-wrapper] *')]
      .filter(el => (el.textContent || '').trim() === 'dsh-plugin-om' && el.children.length === 0);
    if (!items.length) return null;
    const r = items[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  console.log('box:', JSON.stringify(box));
  if (!box) {
    process.exit(1);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.ev(`(() => document.body.innerText.slice(0, 2500))()`);
  console.log('after:', JSON.stringify(after));
  await page.shot('wsselect');
  process.exit(0);
}

// —— 新建会话：选工作区 + 输入 + 发送 ——
async function newchat() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 40; i++) {
    const t = await page.ev(`(() => document.body.innerText)()`);
    if (!t.includes('正在加载工作区')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.ev(clickByText('button', '选择工作区'));
  await new Promise((r) => setTimeout(r, 1500));
  const box = await page.ev(`(() => {
    const items = [...document.querySelectorAll('[role="menu"] *, [role="listbox"] *, [data-radix-popper-content-wrapper] *')]
      .filter(el => (el.textContent || '').trim() === 'dsh-plugin-om' && el.children.length === 0);
    if (!items.length) return null;
    const r = items[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (box) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const sel = await page.ev(`(() => document.body.innerText.slice(0, 200))()`);
  console.log('ws selected:', JSON.stringify(box), 'head:', JSON.stringify(sel));
  const fields =
    await page.ev(`(() => [...document.querySelectorAll('input, textarea, [contenteditable]')]
    .map((el, n) => n + ':' + el.tagName + ':ce=' + (el.getAttribute('contenteditable') || '-') + ':ph=' + (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '') + ':h=' + Math.round(el.getBoundingClientRect().height)).join(' | '))()`);
  console.log('fields:', fields);
  const field = await page.ev(`(() => {
    const els = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(el => el.getBoundingClientRect().height > 10);
    if (!els.length) return null;
    const el = els[0];
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, ce: el.getAttribute('contenteditable'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  console.log('field:', JSON.stringify(field));
  if (!field) {
    process.exit(1);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: field.x,
      y: field.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 500));
  const active = await page.ev(
    `(() => { const a = document.activeElement; return a ? a.tagName + ':ce=' + (a.getAttribute && a.getAttribute('contenteditable')) + ':role=' + (a.getAttribute && a.getAttribute('role')) : 'none'; })()`,
  );
  console.log('active after click:', active);
  await page.send('Input.insertText', { text: 'GUI 冒烟：请回复确认' });
  await new Promise((r) => setTimeout(r, 600));
  const editorText = await page.ev(
    `(() => { const el = document.querySelector('[role="textbox"]'); return el ? JSON.stringify(el.innerText || el.textContent) : 'none'; })()`,
  );
  console.log('editor text:', editorText);
  const sendBox = await page.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || x.textContent || '').includes('发送消息'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  })()`);
  console.log('sendBox:', JSON.stringify(sendBox));
  if (sendBox && !sendBox.disabled) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', {
        type,
        x: sendBox.x,
        y: sendBox.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }
  await new Promise((r) => setTimeout(r, 6000));
  const after = await page.ev(`(() => document.body.innerText.slice(0, 2500))()`);
  console.log('after:', JSON.stringify(after));
  await page.shot('newchat');
  process.exit(0);
}

const step = process.argv[2] ?? 'explore';
// —— 用 CDP 可信鼠标事件点击工作区项 ——
async function wsopen() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 1200));
  const box = await page.ev(`(() => {
    const el = [...document.querySelectorAll('[role="treeitem"], [class*="projectRow"]')]
      .find(e => (e.textContent || '').includes('dsh-plugin-om'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: el.className.toString().slice(0, 60) };
  })()`);
  console.log('box:', JSON.stringify(box));
  if (!box) {
    process.exit(1);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.ev(`(() => document.body.innerText.slice(0, 2000))()`);
  console.log('after:', JSON.stringify(after));
  await page.shot('wsopen');
  process.exit(0);
}

await (async () => {
  if (step === 'wsopen') return wsopen();
  if (step === 'wsselect') return wsselect();
  if (step === 'newchat') return newchat();
  if (step === 'opencomp') return opencomp();
  if (step === 'scrolldiag') return scrolldiag();
  if (step === 'cardview') return cardview();
  if (step === 'cardcheck') return cardcheck();
  if (step === 'discprobe') return discprobe();
  if (step === 'rowprobe') return rowprobe();
  if (step === 'rowshot') return rowshot();
  if (step === 'seatshot') return seatshot();
  if (step === 'recomp') return recomp();
  if (step === 'probe2') return probe2();
  if (step === 'probe3') return probe3();
  if (step === 'probe4') return probe4();
  if (step === 'probe5') return probe5();
  if (step === 'probe6') return probe6();
  if (step === 'probe7') return probe7();
  if (step === 'evalpanel') return evalpanel();
  if (step === 'diag') return diag();
  if (step === 'settings') return settings();
  if (step === 'cfgprobe') return cfgprobe();
  if (step === 'cfgpanel') return cfgpanel();
  if (step === 'clientcheck') return clientcheck();
  if (step === 'explore') return explore();
  if (step === 'sidebar') return sidebar();
  if (step === 'search') return search();
  if (step === 'sessions') return sessions();
  if (step === 'addws') return addws();
  if (step === 'regws') return regws();
  if (step === 'wsclick') return wsclick();
  if (step === 'wsdrop') return wsdrop();
  if (step === 'dbg') return dbg();
  if (step === 'rowdump') return rowdump();
  if (step === 'bundleprobe') return bundleprobe();
  if (step === 'rowcfg') return rowcfg();
  if (step === 'rowwrite') return rowwrite();
  if (step === 'evalgating') return evalgating();
  if (step === 'pagetext') return pagetext();
  throw new Error(`unknown step ${step}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

// —— 选择工作区 dsh-plugin-om（页面内下拉 + 可信点击）——
async function selectWs(page) {
  for (let i = 0; i < 40; i++) {
    const t = await page.ev(`(() => document.body.innerText)()`);
    if (!t.includes('正在加载工作区')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.ev(clickByText('button', '选择工作区'));
  await new Promise((r) => setTimeout(r, 1500));
  const box = await page.ev(`(() => {
    const items = [...document.querySelectorAll('[role="menu"] *, [role="listbox"] *, [data-radix-popper-content-wrapper] *')]
      .filter(el => (el.textContent || '').trim() === 'dsh-plugin-om' && el.children.length === 0);
    if (!items.length) return null;
    const r = items[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

// —— 打开含压缩的旧会话：侧边栏搜索 + 点击结果 ——
async function opencomp() {
  const needle = process.argv[3] || 'omtest-imm';
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('ws:', await selectWs(page));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 800));
  await page.ev(clickByText('button', '搜索会话'));
  await new Promise((r) => setTimeout(r, 800));
  const si = await page.ev(`(() => {
    const el = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('搜索会话名称'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  console.log('search input:', JSON.stringify(si));
  if (!si) process.exit(1);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: si.x,
      y: si.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await page.send('Input.insertText', { text: needle });
  await new Promise((r) => setTimeout(r, 2500));
  const res = await page.ev(`(() => {
    const aside = document.querySelector('aside') || document.body;
    return aside.innerText.slice(0, 1200);
  })()`);
  console.log('results:', JSON.stringify(res));
  const box = await page.ev(`(() => {
    const els = [...document.querySelectorAll('aside *, [class*=sidebar] *, [role=treeitem], [class*=session]')]
      .filter(el => (el.textContent || '').includes(${JSON.stringify(needle)}) && el.children.length <= 2 && el.getBoundingClientRect().height > 10 && el.getBoundingClientRect().height < 120);
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: els[0].tagName, cls: els[0].className && els[0].className.slice ? els[0].className.slice(0, 60) : '' };
  })()`);
  console.log('row:', JSON.stringify(box));
  if (!box) {
    await page.shot('opencomp-miss');
    process.exit(1);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 4000));
  await page.ev(
    `(() => { const els = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 300); els.forEach(e => e.scrollTop = 0); window.scrollTo(0, 0); return els.length; })()`,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const marks = await page.ev(
    `(() => { const t = document.body.innerText; const keys = ['上下文已压缩','点击查看压缩摘要','正在压缩','压缩失败','尝试其他模型','重压缩','子智能体']; return JSON.stringify(keys.map(k => k + '=' + t.includes(k))); })()`,
  );
  console.log('marks:', marks);
  const around = await page.ev(
    `(() => { const t = document.body.innerText; const i = t.indexOf('上下文已压缩'); if (i < 0) return 'NO_CARD_TEXT'; return JSON.stringify(t.slice(Math.max(0, i - 200), i + 400)); })()`,
  );
  console.log('around:', around);
  await page.shot('opencomp-top');
  process.exit(0);
}

// —— 诊断卡片滚动容器 ——
async function scrolldiag() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const out = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    if (!el) return 'NO_CARD';
    const chain = [];
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      chain.push({
        tag: node.tagName, cls: (node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').toString().slice(0, 50),
        oy: cs.overflowY, sh: node.scrollHeight, ch: node.clientHeight, st: Math.round(node.scrollTop),
      });
      node = node.parentElement;
    }
    return JSON.stringify({ vh: window.innerHeight, rectY: Math.round(el.getBoundingClientRect().y), chain }, null, 1);
  })()`);
  console.log(out);
  // 尝试设置最近的可滚容器并观察是否被重置
  const setRes = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    let node = el.parentElement, target = null;
    while (node) { if (node.scrollHeight > node.clientHeight + 10) { target = node; break; } node = node.parentElement; }
    if (!target) return 'NO_SCROLLABLE';
    const before = target.scrollTop;
    target.scrollTop = before + el.getBoundingClientRect().y - 400;
    return JSON.stringify({ before: Math.round(before), after: Math.round(target.scrollTop), delta: Math.round(el.getBoundingClientRect().y) });
  })()`);
  console.log('set:', setRes);
  await new Promise((r) => setTimeout(r, 1000));
  const out2 = await page.ev(`(() => JSON.stringify({
    scrollY: window.scrollY,
    html: { sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight, st: document.documentElement.scrollTop },
    cardAbs: (() => { const el = document.querySelector('[data-om-compaction-summary]'); if (!el) return null; let y = 0, n = el; while (n) { y += n.getBoundingClientRect ? 0 : 0; n = n.parentElement; } const r = el.getBoundingClientRect(); return Math.round(r.y + window.scrollY); })(),
  }))()`);
  console.log('win:', out2);
  const scrollTo = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    if (!el) return 'NO_CARD';
    const abs = el.getBoundingClientRect().y + window.scrollY;
    window.scrollTo(0, Math.max(0, abs - 300));
    return JSON.stringify({ abs: Math.round(abs), scrollY: window.scrollY, rectY: Math.round(el.getBoundingClientRect().y) });
  })()`);
  console.log('scrollTo:', scrollTo);
  await new Promise((r) => setTimeout(r, 1000));
  const after = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    return el ? JSON.stringify({ rectY: Math.round(el.getBoundingClientRect().y), scrollY: window.scrollY }) : 'GONE';
  })()`);
  console.log('rectY after 1s:', after);
  process.exit(0);
}

// —— 滚动到压缩卡片：截图折叠态 + 展开态 ——
async function cardview() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const found = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { y: Math.round(r.y), x: Math.round(r.x), vh: window.innerHeight };
  })()`);
  console.log('found:', JSON.stringify(found));
  if (!found) process.exit(1);
  // 虚拟列表用 transform 定位、无原生滚动：以 wheel 事件向上滚动直到卡片入视口
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(`(() => {
      const el = document.querySelector('[data-om-compaction-summary]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: r.y, vh: window.innerHeight };
    })()`);
    if (!pos) {
      console.log('card unmounted while scrolling');
      break;
    }
    if (pos.y > 80 && pos.y < pos.vh - 80) {
      console.log('in viewport at wheel', i, JSON.stringify(pos));
      break;
    }
    const dy =
      pos.y < 80
        ? -Math.min(700, Math.max(120, 80 + 400 - pos.y))
        : Math.min(700, pos.y - (pos.vh - 480));
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 250));
  }
  // 卡片被折进 turn 进程组（seat 带 hidden）：DOM 点击全部 turn 披露按钮展开进程
  const disc = await page.ev(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('用时'));
    btns.forEach(b => b.click());
    return btns.length;
  })()`);
  console.log('disclosure clicks:', disc);
  await new Promise((r) => setTimeout(r, 1500));
  const grp = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    if (!el) return 'NO_CARD';
    const seat = el.closest('[class*="O_Ebla_root"]');
    if (!seat) return 'NO_SEAT';
    const title = seat.querySelector('[class*="O_Ebla_title"]');
    return JSON.stringify({
      seatHidden: seat.hasAttribute('hidden'),
      titleText: title ? (title.textContent || '').slice(0, 60) : null,
      expanded: title ? title.getAttribute('aria-expanded') : null,
      cardY: Math.round(el.getBoundingClientRect().y),
      cardH: Math.round(el.getBoundingClientRect().height),
    });
  })()`);
  console.log('group seat:', grp);
  // 展开组标题（seat body 折叠时卡片被裁剪不绘制）
  const titleClick = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    const seat = el && el.closest('[class*="O_Ebla_root"]');
    const title = seat && seat.querySelector('[class*="O_Ebla_title"]');
    if (!title) return 'NO_TITLE';
    if (title.getAttribute('aria-expanded') === 'true') return 'SKIP';
    title.click();
    return 'CLICKED';
  })()`);
  console.log('title dom click:', titleClick);
  await new Promise((r) => setTimeout(r, 1200));
  // 展开后位置变化：再次 wheel 微调把卡片带回视口
  for (let i = 0; i < 25; i++) {
    const pos = await page.ev(`(() => {
      const el = document.querySelector('[data-om-compaction-summary]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: r.y, vh: window.innerHeight };
    })()`);
    if (!pos) break;
    if (pos.y > 120 && pos.y < pos.vh - 160) break;
    const dy =
      pos.y < 120
        ? -Math.min(500, Math.max(100, 300 - pos.y))
        : Math.min(500, pos.y - (pos.vh - 400));
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  const r1 = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    if (!el) return null;
    const root = el.closest('.om-compaction-root');
    const rr = (root || el).getBoundingClientRect();
    return { x: rr.x + Math.min(200, rr.width / 2), y: rr.y + rr.height / 2, rootText: root ? (root.textContent || '').slice(0, 150) : null };
  })()`);
  console.log('row:', JSON.stringify(r1));
  await page.shot('cardview-collapsed');
  if (!r1 || r1.y < 0 || r1.y > 2000) {
    console.log('card not in viewport, skip expand');
    process.exit(1);
  }
  // 点击行展开（DOM click 触发 React onClick）
  const rowClick = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    const root = el && el.closest('.om-compaction-root');
    if (!root) return 'NO_ROOT';
    const row = root.querySelector('[data-disclosure-row]') || root;
    row.click();
    return 'CLICKED:' + row.getAttribute('aria-expanded');
  })()`);
  console.log('row dom click:', rowClick);
  await new Promise((r) => setTimeout(r, 1500));
  const exp = await page.ev(`(() => {
    const body = document.querySelector('.om-compaction-body');
    const actions = document.querySelector('[data-om-compaction-actions]');
    return JSON.stringify({
      body: body ? body.textContent.slice(0, 400) : null,
      actions: actions ? actions.textContent : null,
      inspect: !!document.querySelector('[data-om-compaction-inspect]'),
    });
  })()`);
  console.log('expanded:', exp);
  await page.shot('cardview-expanded');
  process.exit(0);
}

// —— 卡片 DOM 探针 + 轨迹页事件核查 ——
// —— 披露行与 seat 可见性探针 ——
async function discprobe() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(`(() => {
      const el = document.querySelector('[data-om-compaction-summary]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: r.y, vh: window.innerHeight };
    })()`);
    if (!pos) break;
    if (pos.y > 120 && pos.y < pos.vh - 160) break;
    const dy = pos.y < 0 ? 400 : pos.y < 120 ? -300 : 300;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  const dump = await page.ev(`(() => {
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const t = e.textContent || '';
      if (t.includes('用时') && t.length < 40) {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        out.push({ tag: e.tagName, cls: String(e.className).slice(0, 60), kids: e.childElementCount, y: Math.round(r.y), h: Math.round(r.height), vis: cs.visibility, disp: cs.display, op: cs.opacity, text: t.slice(0, 30) });
      }
    }
    const el = document.querySelector('[data-om-compaction-summary]');
    const seat = el && el.closest('[class*="O_Ebla_root"]');
    let seatInfo = null;
    if (seat) {
      const cs = getComputedStyle(seat);
      const r = seat.getBoundingClientRect();
      seatInfo = { cls: seat.className.slice(0, 60), hidden: seat.hasAttribute('hidden'), vis: cs.visibility, disp: cs.display, op: cs.opacity, y: Math.round(r.y), h: Math.round(r.height), ch: seat.clientHeight };
      let p = seat.parentElement, chain = [];
      while (p && chain.length < 6) {
        const pcs = getComputedStyle(p);
        chain.push({ cls: String(p.className).slice(0, 40), vis: pcs.visibility, disp: pcs.display, op: pcs.opacity, h: Math.round(p.getBoundingClientRect().height), cv: pcs.contentVisibility });
        p = p.parentElement;
      }
      seatInfo.chain = chain;
    }
    return JSON.stringify({ hits: out.slice(0, 8), seat: seatInfo }, null, 1);
  })()`);
  console.log(dump);
  process.exit(0);
}

async function seatshot() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await page.ev(
    `(() => { [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('用时')).forEach(b => b.click()); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(
      `(() => { const el = document.querySelector('[data-om-compaction-summary]'); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.y, vh: window.innerHeight }; })()`,
    );
    if (!pos) break;
    if (pos.y > 200 && pos.y < pos.vh - 300) break;
    const dy = pos.y < 200 ? -300 : 300;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  const t1 = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    const seat = el && el.closest('[class*="O_Ebla_root"]');
    const title = seat && seat.querySelector('[class*="O_Ebla_title"]');
    if (!title) return 'NO_TITLE';
    title.click();
    return 'CLICKED:' + title.getAttribute('aria-expanded');
  })()`);
  console.log('title click:', t1);
  await new Promise((r) => setTimeout(r, 1500));
  const probe = await page.ev(`(() => {
    const el = document.querySelector('[data-om-compaction-summary]');
    const seat = el && el.closest('[class*="O_Ebla_root"]');
    if (!seat) return 'NO_SEAT';
    const title = seat.querySelector('[class*="O_Ebla_title"]');
    const bodies = [...seat.querySelectorAll('div')].filter(d => /O_Ebla_(expanded)?[Bb]ody/.test(d.className));
    const sr = seat.getBoundingClientRect();
    return JSON.stringify({
      aria: title && title.getAttribute('aria-expanded'),
      bodies: bodies.map(b => ({ cls: b.className.slice(0, 50), h: b.clientHeight, sh: b.scrollHeight, ov: getComputedStyle(b).overflowY, mh: getComputedStyle(b).maxHeight })),
      seat: { y: Math.round(sr.y), h: Math.round(sr.height) },
      cardY: Math.round(el.getBoundingClientRect().y),
    });
  })()`);
  console.log('seat probe:', probe);
  const b = JSON.parse(probe);
  await page
    .send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: 150,
        y: Math.max(0, b.seat.y - 10),
        width: 1100,
        height: Math.min(950, b.seat.h + 20),
        scale: 1,
      },
    })
    .then(async (res) => {
      const fs = await import('node:fs');
      fs.writeFileSync('shots/seatshot.png', Buffer.from(res.data, 'base64'));
      console.log('shot saved');
    });
  process.exit(0);
}

async function rowshot() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await page.ev(
    `(() => { [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('用时')).forEach(b => b.click()); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(
      `(() => { const el = document.querySelector('[data-om-compaction-summary]'); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.y, vh: window.innerHeight }; })()`,
    );
    if (!pos) break;
    if (pos.y > 150 && pos.y < pos.vh - 300) break;
    const dy = pos.y < 150 ? -300 : 300;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  await page.ev(
    `(() => { const root = document.querySelector('.om-compaction-root'); const row = root && root.querySelector('[data-disclosure-row]'); if (row) row.click(); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const box = await page.ev(`(() => {
    const root = document.querySelector('.om-compaction-root');
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const cs = getComputedStyle(root);
    const row = root.querySelector('[data-disclosure-row]');
    const rcs = row ? getComputedStyle(row) : null;
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, vis: cs.visibility, disp: cs.display, op: cs.opacity, rowVis: rcs && rcs.visibility, rowH: row ? row.getBoundingClientRect().height : null });
  })()`);
  console.log('root box:', box);
  const b = JSON.parse(box);
  await page
    .send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, b.x - 8),
        y: Math.max(0, b.y - 8),
        width: Math.min(1200, b.w + 16),
        height: Math.min(900, b.h + 16),
        scale: 1,
      },
    })
    .then(async (res) => {
      const fs = await import('node:fs');
      fs.writeFileSync('shots/rowshot.png', Buffer.from(res.data, 'base64'));
      console.log('shot saved shots/rowshot.png');
    });
  process.exit(0);
}

async function rowprobe() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await page.ev(
    `(() => { [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('用时')).forEach(b => b.click()); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(
      `(() => { const el = document.querySelector('[data-om-compaction-summary]'); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.y, vh: window.innerHeight }; })()`,
    );
    if (!pos) break;
    if (pos.y > 120 && pos.y < pos.vh - 160) break;
    const dy = pos.y < 120 ? -300 : 300;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: dy,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  const dump = await page.ev(`(() => {
    const root = document.querySelector('.om-compaction-root');
    if (!root) return 'NO_ROOT';
    const cs = getComputedStyle(root);
    return JSON.stringify({
      tag: root.tagName, role: root.getAttribute('role'), aria: root.getAttribute('aria-expanded'),
      cursor: cs.cursor, html: root.outerHTML.slice(0, 900),
    }, null, 1);
  })()`);
  console.log(dump);
  const after = await page.ev(
    `(() => { const root = document.querySelector('.om-compaction-root'); root.click(); return new Promise(res => setTimeout(() => { const b = document.querySelector('.om-compaction-body'); const a = document.querySelector('[data-om-compaction-actions]'); res(JSON.stringify({ aria: root.getAttribute('aria-expanded'), body: b ? b.textContent.slice(0, 200) : null, actions: a ? a.textContent : null })); }, 1200)); })()`,
  );
  console.log('after click:', after);
  await page.shot('rowprobe');
  process.exit(0);
}

async function cardcheck() {
  const needle = process.argv[3] || '首轮详细背景';
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
  }
  await new Promise((r) => setTimeout(r, 1500));
  // 若未自动恢复目标会话，走侧边栏搜索打开
  const opened = await page.ev(
    `(() => document.body.innerText.includes(${JSON.stringify(needle)}))()`,
  );
  console.log('session already open:', opened);
  if (!opened) {
    await page.ev(clickByText('button', '打开侧边栏'));
    await new Promise((r) => setTimeout(r, 800));
    await page.ev(clickByText('button', '搜索会话'));
    await new Promise((r) => setTimeout(r, 800));
    const si = await page.ev(`(() => {
      const el = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('搜索会话名称'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (si) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', {
          type,
          x: si.x,
          y: si.y,
          button: 'left',
          clickCount: 1,
        });
      }
      await page.send('Input.insertText', { text: needle });
      await new Promise((r) => setTimeout(r, 2500));
      const box = await page.ev(`(() => {
        const els = [...document.querySelectorAll('aside *, [role=treeitem], [class*=session]')]
          .filter(el => (el.textContent || '').includes(${JSON.stringify(needle)}) && el.children.length <= 2 && el.getBoundingClientRect().height > 10 && el.getBoundingClientRect().height < 120);
        if (!els.length) return null;
        const r = els[0].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      console.log('row:', JSON.stringify(box));
      if (box) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', {
            type,
            x: box.x,
            y: box.y,
            button: 'left',
            clickCount: 1,
          });
        }
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  // 1) 插件卡片 DOM 探针
  const probe = await page.ev(`(() => {
    const sel = '[data-om-compaction-summary],[data-om-compaction-actions],[data-om-recompress-running],[data-om-recompress-result]';
    const els = [...document.querySelectorAll(sel)];
    return JSON.stringify({ count: els.length, texts: els.slice(0, 5).map(e => e.tagName + ':' + (e.textContent || '').slice(0, 80)) });
  })()`);
  console.log('card probe:', probe);
  const marks = await page.ev(
    `(() => { const t = document.body.innerText; const keys = ['上下文已压缩','点击查看压缩摘要','正在压缩','压缩失败','尝试其他模型']; return JSON.stringify(keys.map(k => k + '=' + t.includes(k))); })()`,
  );
  console.log('marks:', marks);
  // 2) 打开轨迹页，确认 compaction 事件到达浏览器
  const traj = await page.ev(clickByText('*', '轨迹'));
  console.log('traj click:', traj);
  await new Promise((r) => setTimeout(r, 2500));
  const trajText = await page.ev(
    `(() => { const t = document.body.innerText; const i = t.indexOf('compaction'); return i < 0 ? 'NO_COMPACTION_IN_TRAJ:' + t.length : JSON.stringify(t.slice(Math.max(0, i - 100), i + 500)); })()`,
  );
  console.log('traj:', trajText);
  const compCount = await page.ev(
    `(() => (document.body.innerText.match(/compaction\\/(start|summary|end)/g) || []).join(','))()`,
  );
  console.log('traj compaction events:', compCount);
  await page.shot('cardcheck-traj');
  // 回到对话页再截图
  await page.ev(clickByText('*', '对话'));
  await new Promise((r) => setTimeout(r, 2000));
  await page.shot('cardcheck-chat');
  process.exit(0);
}

// —— 诊断日志：打开压缩卡片 → 点「诊断日志」→ 断言切到诊断子会话，并汇总 console / 网络错误 ——
async function diag() {
  const page = await connect(GUI);
  await page.send('Network.enable');
  await page.send('Log.enable');
  await openCard(page);
  const before = await page.ev(
    `(() => JSON.stringify({ href: location.href, header: (document.querySelector('header')?.textContent || '').slice(0, 120) }))()`,
  );
  console.log('before:', before);
  // 按钮文案见 src/client/locales.ts card.inspect；按 data 属性定位，不依赖文案
  const btn = await page.ev(`(() => {
    const b = document.querySelector('[data-om-compaction-inspect]');
    if (!b) return 'NO_INSPECT';
    b.scrollIntoView({ block: 'center' });
    const text = (b.textContent || '').trim();
    b.click();
    return 'CLICKED:' + text;
  })()`);
  console.log('inspect:', btn);
  await new Promise((r) => setTimeout(r, 3500));
  const after = await page.ev(
    `(() => JSON.stringify({ href: location.href, header: (document.querySelector('header')?.textContent || '').slice(0, 120), body: document.body.innerText.slice(0, 600) }))()`,
  );
  console.log('after:', after);
  const b = JSON.parse(before);
  const a = JSON.parse(after);
  const switched = btn.startsWith('CLICKED') && (a.href !== b.href || a.header !== b.header);
  console.log('switched:', switched);
  const cons = page.events
    .filter(
      (m) =>
        m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type),
    )
    .slice(0, 12)
    .map(
      (m) =>
        m.params.type +
        ': ' +
        (m.params.args || [])
          .map((x) => x.value || x.description || '')
          .join(' ')
          .slice(0, 200),
    );
  console.log('console:', JSON.stringify(cons, null, 1));
  const bad = page.events
    .filter((m) => m.method === 'Network.responseReceived' && m.params.response.status >= 400)
    .map((m) => `${m.params.response.status} ${m.params.response.url.slice(0, 120)}`);
  console.log('netbad:', JSON.stringify(bad, null, 1));
  await page.shot('diag');
  process.exit(switched ? 0 : 1);
}

// —— 设置页检查客户端插件是否加载 ——
// —— 插件管理器进配置表单：侧边栏「插件」→ 刷新 → 列表卡片「查看」进详情页 → 组件行「配置」 ——
async function openPluginConfig(page, name = 'dsh-plugin-om') {
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    await selectWs(page);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const clickA = (label) =>
    page.ev(
      `((label) => { const b = [...document.querySelectorAll('button[aria-label]')].find(x => x.getAttribute('aria-label') === label); if (!b) return 'NO_BTN'; b.scrollIntoView({ block: 'center' }); b.click(); return 'CLICKED'; })( ${JSON.stringify(label)} )`,
    );
  const waitA = async (label, ms = 8000) => {
    for (let t = 0; t < ms; t += 500) {
      const r = await clickA(label);
      if (r === 'CLICKED') return r;
      await new Promise((r) => setTimeout(r, 500));
    }
    return 'NO_BTN';
  };
  console.log('sidebar:', await clickA('打开侧边栏'));
  await new Promise((r) => setTimeout(r, 700));
  console.log('plugin manager:', await waitA('插件'));
  await new Promise((r) => setTimeout(r, 2000));
  // 已安装区为空时刷新一次
  let detail = await waitA(`查看 ${name}`, 3000);
  if (detail !== 'CLICKED') {
    console.log('refresh:', await clickA('刷新'));
    detail = await waitA(`查看 ${name}`);
  }
  console.log('open detail:', detail);
  await new Promise((r) => setTimeout(r, 1500));
  const cfg = await waitA(`配置 ${name}`);
  console.log('open config:', cfg);
  await new Promise((r) => setTimeout(r, 2000));
  return cfg === 'CLICKED';
}

async function cfgprobe() {
  const page = await connect(GUI);
  console.log('config opened:', await openPluginConfig(page));
  const dump = await page.ev(`(() => {
    const cfg = document.querySelector('[data-plugin-config]');
    const rowline = document.querySelector('.X_2TxG_rowLine');
    const btns = rowline ? [...rowline.querySelectorAll('button,[role=button],a')].map(b => b.tagName + '|' + (b.className||'').toString().slice(0,50) + '|' + (b.textContent||'').trim().slice(0,40) + '|aria=' + b.getAttribute('aria-expanded')) : [];
    return JSON.stringify({
      cfgExists: !!cfg,
      cfgHtml: cfg ? cfg.innerHTML.slice(0, 800) : null,
      cfgText: cfg ? (cfg.innerText || '').slice(0, 400) : null,
      rowlineHtml: rowline ? rowline.outerHTML.slice(0, 1200) : null,
      btns,
    }, null, 1);
  })()`);
  console.log(dump);
  await page.shot('cfgprobe');
  process.exit(0);
}

async function cfgpanel() {
  const page = await connect(GUI);
  console.log('config opened:', await openPluginConfig(page));
  await new Promise((r) => setTimeout(r, 2000));
  const dump = await page.ev(`(() => {
    const txt = document.body.innerText;
    // 常显字段标签取自 src/client/locales.ts 的 config.*；嵌入模型目录随语义增强、重发阈值随长期无记录重发条件显示
    const labels = ['观察阈值','摘要合并阈值','保留消息数','单次生成上限','压缩 Provider','压缩模型','思考等级','忽略思考内容','限流等待毫秒数','重压缩并发数','自动压缩','进度提醒','长期无记录时重发','原文召回','步骤日志','保存修改','恢复默认'];
    const found = {};
    for (const l of labels) found[l] = txt.includes(l);
    found.missing = labels.filter((l) => !found[l]);
    // locate the plugin config card region
    const idx = txt.indexOf('配置上下文压缩');
    const pmIdx = txt.indexOf('安装、启用和配置插件');
    return JSON.stringify({ found, descIdx: idx, snippet: idx >= 0 ? txt.slice(idx, idx + 900) : (pmIdx >= 0 ? txt.slice(pmIdx, pmIdx + 2500) : txt.slice(0, 900)) }, null, 1);
  })()`);
  console.log(dump);
  await page.shot('cfgpanel');
  // edit round-trip: change 观察阈值, expect 撤销修改, revert without saving
  const editTest = await page.ev(`(() => {
    const labels = [...document.querySelectorAll('label,span,div,p')].filter(x => (x.textContent || '').trim() === '观察阈值');
    if (!labels.length) return 'NO_LABEL';
    let scope = labels[0];
    for (let i = 0; i < 6 && scope; i++) { scope = scope.parentElement; if (scope && scope.querySelector('input')) break; }
    const input = scope && scope.querySelector('input');
    if (!input) return 'NO_INPUT';
    const before = input.value;
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(input, String(Number(before) + 1));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ before, after: input.value });
  })()`);
  console.log('edit:', editTest);
  await new Promise((r) => setTimeout(r, 1200));
  const discard = await page.ev(`(() => {
    const txt = document.body.innerText;
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '撤销修改');
    const save = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '保存修改');
    return JSON.stringify({ hasDiscard: txt.includes('撤销修改'), hasSave: !!save, saveDisabled: save ? save.disabled : null, btnFound: !!btn });
  })()`);
  console.log('discard state:', discard);
  await page.shot('cfgpanel-edited');
  const revert = await page.ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '撤销修改');
    if (!btn) return 'NO_DISCARD';
    btn.click();
    return 'CLICKED';
  })()`);
  console.log('revert:', revert);
  await new Promise((r) => setTimeout(r, 1200));
  const afterRevert = await page.ev(`(() => {
    const labels = [...document.querySelectorAll('label,span,div,p')].filter(x => (x.textContent || '').trim() === '观察阈值');
    let scope = labels[0];
    for (let i = 0; i < 6 && scope; i++) { scope = scope.parentElement; if (scope && scope.querySelector('input')) break; }
    const input = scope && scope.querySelector('input');
    const txt = document.body.innerText;
    return JSON.stringify({ value: input ? input.value : null, discardGone: !txt.includes('撤销修改'), saveFailed: txt.includes('保存失败') || txt.includes('版本冲突') });
  })()`);
  console.log('after revert:', afterRevert);
  await page.shot('cfgpanel-reverted');
  process.exit(0);
}

async function settings() {
  const page = await connect(GUI);
  await page.send('Network.enable');
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3000));
  const urls = page.events
    .filter((m) => m.method === 'Network.requestWillBeSent')
    .map((m) => m.params.request.url)
    .filter((u) => /client|plugin|\.js/.test(u))
    .slice(0, 30);
  console.log('jsurls:', JSON.stringify(urls, null, 1));
  await page.ev(clickByText('button', '设置'));
  await new Promise((r) => setTimeout(r, 2500));
  const t = await page.ev(`(() => document.body.innerText.slice(0, 4000))()`);
  console.log('settings:', JSON.stringify(t));
  await page.shot('settings');
  process.exit(0);
}

// —— 客户端插件加载核查：reload 抓全部请求 + 侧边栏进设置 ——
async function clientcheck() {
  const page = await connect(GUI);
  await page.send('Network.enable');
  await page.send('Page.reload', {});
  await new Promise((r) => setTimeout(r, 7000));
  const urls = page.events
    .filter((m) => m.method === 'Network.requestWillBeSent')
    .map((m) => m.params.request.url);
  console.log(
    'js:',
    JSON.stringify(
      urls.filter((u) => /\.js(\?|$)|plugin|client/.test(u)),
      null,
      1,
    ),
  );
  const bad = page.events
    .filter((m) => m.method === 'Network.responseReceived' && m.params.response.status >= 400)
    .map((m) => `${m.params.response.status} ${m.params.response.url.slice(0, 140)}`);
  console.log('bad:', JSON.stringify(bad, null, 1));
  const cons = page.events
    .filter((m) => m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    .slice(0, 10)
    .map((m) =>
      (m.params.args || [])
        .map((a) => a.value || a.description || '')
        .join(' ')
        .slice(0, 240),
    );
  console.log('cons:', JSON.stringify(cons, null, 1));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 1000));
  await page.ev(clickByText('button', '设置'));
  await new Promise((r) => setTimeout(r, 2500));
  const t = await page.ev(`(() => document.body.innerText)()`);
  console.log(
    'hasOmConfig:',
    t.includes('dsh-plugin-om'),
    'hasObserve:',
    t.includes('observe'),
    'len:',
    t.length,
  );
  const _i = t.indexOf('插件');
  console.log('settingsTail:', JSON.stringify(t.slice(0, 1500)));
  await page.shot('clientcheck');
  process.exit(0);
}

// 打开 omtest-imm 会话并展开压缩卡片（披露→组标题），返回 page
async function openCard(page) {
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) await selectWs(page);
  await new Promise((r) => setTimeout(r, 1200));
  // GUI 会恢复上次路由；子会话面包屑也含父标题，须排除「OM会话」子会话
  const already = await page.ev(
    `(() => { const h = document.querySelector('header'); const t = (h && h.textContent) || ''; return t.includes('首轮详细背景') && !t.includes('OM会话'); })()`,
  );
  console.log('already open:', already);
  if (!already) {
    const findSearch = () =>
      page.ev(
        `(() => { const i = [...document.querySelectorAll('input')].find(x => (x.placeholder || '').includes('搜索会话名称')); if (!i) return null; const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
    const clickAria = (label) =>
      page.ev(
        `((label) => { const b = [...document.querySelectorAll('button[aria-label]')].find(x => x.getAttribute('aria-label') === label); if (!b) return 'NO_BTN'; b.click(); return 'CLICKED'; })( ${JSON.stringify(label)} )`,
      );
    let box = await findSearch();
    if (!box) {
      await clickAria('搜索会话');
      await new Promise((r) => setTimeout(r, 800));
      box = await findSearch();
    }
    if (!box) {
      await clickAria('打开侧边栏');
      await new Promise((r) => setTimeout(r, 800));
      await clickAria('搜索会话');
      await new Promise((r) => setTimeout(r, 800));
      box = await findSearch();
    }
    if (!box) throw new Error('search input not found');
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.send('Input.insertText', { text: '首轮详细背景' });
    await new Promise((r) => setTimeout(r, 2500));
    const sv = await page.ev(
      `(() => { const i = [...document.querySelectorAll('input')].find(x => (x.placeholder || '').includes('搜索会话名称')); return i ? i.value : null; })()`,
    );
    console.log('search value:', JSON.stringify(sv));
    if (!sv?.includes('首轮详细背景')) {
      await page.ev(
        `(() => { const i = [...document.querySelectorAll('input')].find(x => (x.placeholder || '').includes('搜索会话名称')); if (!i) return 0; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(i, '首轮详细背景'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`,
      );
      await new Promise((r) => setTimeout(r, 2500));
    }
    const row = await page.ev(`(() => {
    const els = [...document.querySelectorAll('[class*="searchTree"] *, aside *, [class*=sidebar] *')].filter(e => e.children.length <= 2 && (e.textContent || '').includes('首轮详细背景'));
    const el = els.find(e => { const r = e.getBoundingClientRect(); return r.height > 10 && r.height < 120; });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
    if (!row) {
      const dbg = await page.ev(
        `(() => JSON.stringify([...document.querySelectorAll('*')].filter(e => e.children.length <= 2 && (e.textContent || '').includes('首轮详细背景')).slice(0, 12).map(e => { const r = e.getBoundingClientRect(); return e.tagName + '|' + (e.className || '').toString().slice(0, 40) + '|' + Math.round(r.height) + '|' + (e.closest('aside') ? 'aside' : e.closest('[class*=sidebar]') ? 'sb' : 'other'); })))()`,
      );
      console.log('row candidates:', dbg);
      throw new Error('session row not found');
    }
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: row.x,
      y: row.y,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: row.x,
      y: row.y,
      button: 'left',
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 3500));
  }
  await page.ev(
    `(() => { [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('用时')).forEach(b => b.click()); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  for (let i = 0; i < 40; i++) {
    const pos = await page.ev(
      `(() => { const el = document.querySelector('[data-om-compaction-summary]'); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.y, vh: window.innerHeight }; })()`,
    );
    if (!pos) break;
    if (pos.y > 200 && pos.y < pos.vh - 300) break;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 600,
      y: 500,
      deltaX: 0,
      deltaY: pos.y < 200 ? -300 : 300,
    });
    await new Promise((r) => setTimeout(r, 220));
  }
  await page.ev(
    `(() => { const el = document.querySelector('[data-om-compaction-summary]'); const seat = el && el.closest('[class*="O_Ebla_root"]'); const title = seat && seat.querySelector('[class*="O_Ebla_title"]'); if (title && title.getAttribute('aria-expanded') !== 'true') title.click(); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  await page.ev(
    `(() => { const root = document.querySelector('.om-compaction-root'); const row = root && root.querySelector('[data-disclosure-row]'); if (row && row.getAttribute('aria-expanded') !== 'true') row.click(); return 1; })()`,
  );
  await new Promise((r) => setTimeout(r, 1000));
}

async function probe7() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
    await new Promise((r) => setTimeout(r, 2000));
  }
  const ed = await page.ev(
    `(() => { const e = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().height > 10); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!ed) {
    console.log('NO_EDITOR');
    process.exit(1);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: ed.x,
    y: ed.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: ed.x,
    y: ed.y,
    button: 'left',
    clickCount: 1,
  });
  const key = (type, k, code, vk, mods) =>
    page.send(
      'Input.dispatchKeyEvent',
      Object.assign(
        {
          type,
          key: k,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          modifiers: mods || 0,
        },
        type === 'char' ? { text: k } : {},
      ),
    );
  await key('keyDown', 'a', 'KeyA', 65, 2);
  await key('keyUp', 'a', 'KeyA', 65, 2);
  await key('keyDown', 'Backspace', 'Backspace', 8);
  await key('keyUp', 'Backspace', 'Backspace', 8);
  await key('keyDown', '/', 'Slash', 191);
  await key('char', '/', 'Slash', 191);
  await key('keyUp', '/', 'Slash', 191);
  await new Promise((r) => setTimeout(r, 1200));
  const clicked = await page.ev(
    `(() => { const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent || '').trim().startsWith('om-compaction-eval')); if (!el) return 'NO_OPTION'; el.click(); return 'CLICKED'; })()`,
  );
  console.log('option:', clicked);
  for (const ms of [500, 1500, 3000]) {
    await new Promise((r) => setTimeout(r, ms === 500 ? 500 : ms - (ms === 1500 ? 500 : 1500)));
    const dump = await page.ev(`(() => JSON.stringify({
      panel: !!document.querySelector('.om-eval-panel'),
      omEvalNodes: [...document.querySelectorAll('[class*=om-eval]')].length,
      portals: [...document.querySelectorAll('[data-radix-portal], [class*=portal]')].map(e => (e.textContent || '').trim().slice(0, 80)),
      dialogs: [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].map(e => (e.textContent || '').trim().slice(0, 80)),
      startBtn: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(t => t.includes('开始分析') || t.includes('Start analysis')),
    }, null, 1))()`);
    console.log(`t+${ms}:`, dump);
  }
  await page.shot('probe7');
  process.exit(0);
}

async function probe6() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
    await new Promise((r) => setTimeout(r, 2000));
  }
  const editor = await page.ev(
    `(() => { const e = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().height > 10); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!editor) {
    console.log('NO_EDITOR');
    process.exit(1);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  const key = (type, k, code, vk, mods) =>
    page.send(
      'Input.dispatchKeyEvent',
      Object.assign(
        {
          type,
          key: k,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          modifiers: mods || 0,
        },
        type === 'char' ? { text: k } : {},
      ),
    );
  await key('keyDown', 'a', 'KeyA', 65, 2);
  await key('keyUp', 'a', 'KeyA', 65, 2);
  await key('keyDown', 'Backspace', 'Backspace', 8);
  await key('keyUp', 'Backspace', 'Backspace', 8);
  await new Promise((r) => setTimeout(r, 400));
  console.log(
    'cleared:',
    await page.ev(`(() => (document.activeElement && document.activeElement.textContent) || '')()`),
  );
  await key('keyDown', '/', 'Slash', 191);
  await key('char', '/', 'Slash', 191);
  await key('keyUp', '/', 'Slash', 191);
  await new Promise((r) => setTimeout(r, 1200));
  const dump = await page.ev(`((ey) => JSON.stringify({
    editorText: (document.activeElement && document.activeElement.textContent) || '',
    cands: [...document.querySelectorAll('*')].filter(e => e.children.length <= 3 && (e.textContent || '').includes('om-compaction-eval') && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().y < ey - 40 && !/EvIC1a|_5OnbHa|jhda5|1rdzk/.test((e.className || '').toString())).slice(0, 12).map(e => { const r = e.getBoundingClientRect(); return e.tagName + '|role=' + e.getAttribute('role') + '|' + (e.className || '').toString().slice(0, 60) + '|y=' + Math.round(r.y) + '|' + (e.textContent || '').trim().slice(0, 60); }),
  }, null, 1))( ${JSON.stringify(editor.y)} )`);
  console.log(dump);
  await page.shot('probe6');
  process.exit(0);
}

async function probe5() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
    await new Promise((r) => setTimeout(r, 2000));
  }
  const editor = await page.ev(
    `(() => { const e = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().height > 10); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!editor) {
    console.log('NO_EDITOR');
    process.exit(1);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  await page.ev(
    `(() => { const e = document.activeElement; if (e && e.isContentEditable) { const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(range); document.execCommand('delete'); } return document.activeElement ? document.activeElement.textContent : 'none'; })()`,
  );
  await page.send('Input.insertText', { text: '/om-compaction' });
  await new Promise((r) => setTimeout(r, 1500));
  const dump = await page.ev(`((ey) => JSON.stringify({
    editorText: (document.activeElement && document.activeElement.textContent) || '',
    cands: [...document.querySelectorAll('*')].filter(e => e.children.length <= 3 && (e.textContent || '').includes('om-compaction-eval') && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().y < ey && e.getBoundingClientRect().y > 200).slice(0, 12).map(e => { const r = e.getBoundingClientRect(); return e.tagName + '|role=' + e.getAttribute('role') + '|' + (e.className || '').toString().slice(0, 60) + '|y=' + Math.round(r.y) + '|' + (e.textContent || '').trim().slice(0, 50); }),
  }, null, 1))( ${JSON.stringify(editor.y)} )`);
  console.log(dump);
  await page.shot('probe5');
  process.exit(0);
}

async function probe4() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = await page.ev(`(() => document.body.innerText.includes('正在加载工作区'))()`);
  if (t0) {
    console.log('ws:', await selectWs(page));
    await new Promise((r) => setTimeout(r, 2000));
  }
  const editor = await page.ev(
    `(() => { const e = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().height > 10); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  console.log('editor:', JSON.stringify(editor));
  if (!editor) process.exit(1);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: editor.x,
    y: editor.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.insertText', { text: '/om-compaction' });
  await new Promise((r) => setTimeout(r, 1500));
  const dump = await page.ev(`(() => JSON.stringify({
    opts: [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-command-item],[class*=palette] [class*=item],[class*=command] [class*=item],[class*=mention] [class*=item]')].slice(0, 15).map(e => ({
      tag: e.tagName, role: e.getAttribute('role'), cls: (e.className || '').toString().slice(0, 50), text: (e.textContent || '').trim().slice(0, 60),
    })),
    popups: [...document.querySelectorAll('[data-radix-popper-content-wrapper],[class*=popover],[class*=dropdown],[class*=popup]')].slice(0, 8).map(e => (e.textContent || '').trim().slice(0, 120)),
  }, null, 1))()`);
  console.log(dump);
  await page.shot('probe4');
  process.exit(0);
}

async function probe3() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3000));
  const info = await page.ev(`(() => JSON.stringify({
    aria: [...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')).slice(0, 30),
    icons: [...document.querySelectorAll('nav button, [class*=rail] button, [class*=sidebar] button')].length,
  }, null, 1))()`);
  console.log(info);
  process.exit(0);
}

async function probe2() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 4000));
  const info = await page.ev(`(() => JSON.stringify({
    url: location.href.slice(0, 80),
    title: document.title,
    buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(t => t && t.length < 20).slice(0, 25),
    inputs: [...document.querySelectorAll('input')].map(i => i.placeholder || i.type),
    head: document.body.innerText.slice(0, 300),
  }, null, 1))()`);
  console.log(info);
  process.exit(0);
}

async function recomp() {
  const page = await connect(GUI);
  await openCard(page);
  const open = await page.ev(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '尝试其他模型'); if (!b) return 'NO_BTN'; b.click(); return 'CLICKED'; })()`,
  );
  console.log('recompress button:', open);
  await new Promise((r) => setTimeout(r, 1500));
  const menu = await page.ev(`(() => {
    const p = document.querySelector('.om-recompress-panel');
    if (!p) return 'NO_PANEL';
    return JSON.stringify({
      models: [...p.querySelectorAll('[data-om-recompress-model]')].map(e => e.getAttribute('data-om-recompress-model')),
      text: p.textContent.slice(0, 300),
    });
  })()`);
  console.log('menu:', menu);
  const pick = await page.ev(`(() => {
    const row = document.querySelector('[data-om-recompress-model="mock/claude-mock"]');
    if (!row) return 'NO_MODEL_ROW';
    row.click();
    return 'PICKED';
  })()`);
  console.log('pick model:', pick);
  await new Promise((r) => setTimeout(r, 800));
  const efforts = await page.ev(
    `(() => [...document.querySelectorAll('[data-om-recompress-effort]')].map(e => e.getAttribute('data-om-recompress-effort') || 'default').join(','))()`,
  );
  console.log('efforts:', efforts);
  const pickE = await page.ev(
    `(() => { const e = document.querySelector('[data-om-recompress-effort="low"]'); if (!e) return 'NO_EFFORT'; e.click(); return 'PICKED'; })()`,
  );
  console.log('pick effort:', pickE);
  await new Promise((r) => setTimeout(r, 500));
  const start = await page.ev(
    `(() => { const b = document.querySelector('[data-om-recompress-start]'); if (!b) return 'NO_START'; const t = b.textContent; b.click(); return 'CLICKED:' + t; })()`,
  );
  console.log('start:', start);
  await new Promise((r) => setTimeout(r, 6000));
  const after = await page.ev(`(() => {
    const txt = document.body.innerText;
    return JSON.stringify({
      done: txt.includes('重压缩完成'),
      started: txt.includes('压缩开始') || txt.includes('重压缩中'),
      tail: txt.slice(-600),
    });
  })()`);
  console.log('after:', after);
  await page.shot('recomp');
  process.exit(0);
}

async function evalpanel() {
  const page = await connect(GUI);
  await openCard(page);
  const ed = await page.ev(`(() => {
    const els = [...document.querySelectorAll('[contenteditable="true"], textarea, [role=textbox]')].filter(e => { const r = e.getBoundingClientRect(); return r.height > 20 && r.width > 200; });
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!ed) throw new Error('composer not found');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: ed.x,
    y: ed.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: ed.x,
    y: ed.y,
    button: 'left',
    clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 500));
  const key = (type, k, code, vk, mods) =>
    page.send(
      'Input.dispatchKeyEvent',
      Object.assign(
        {
          type,
          key: k,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          modifiers: mods || 0,
        },
        type === 'char' ? { text: k } : {},
      ),
    );
  await key('keyDown', 'a', 'KeyA', 65, 2);
  await key('keyUp', 'a', 'KeyA', 65, 2);
  await key('keyDown', 'Backspace', 'Backspace', 8);
  await key('keyUp', 'Backspace', 'Backspace', 8);
  await new Promise((r) => setTimeout(r, 400));
  await key('keyDown', '/', 'Slash', 191);
  await key('char', '/', 'Slash', 191);
  await key('keyUp', '/', 'Slash', 191);
  await new Promise((r) => setTimeout(r, 1200));
  await page.send('Input.insertText', { text: 'om-compaction-eval' });
  await new Promise((r) => setTimeout(r, 800));
  await key('keyDown', 'Enter', 'Enter', 13);
  await key('keyUp', 'Enter', 'Enter', 13);
  const palette = 'ENTER_SUBMITTED';
  console.log('palette:', palette);
  await new Promise((r) => setTimeout(r, 1500));
  const panel = await page.ev(`(() => {
    const p = document.querySelector('.om-eval-panel');
    if (!p) return 'NO_PANEL';
    return JSON.stringify({
      models: [...p.querySelectorAll('.om-eval-left [role=radio], .om-eval-left button, .om-eval-row')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 12),
      text: p.textContent.slice(0, 200),
    });
  })()`);
  console.log('panel:', panel);
  const pick = await page.ev(`(() => {
    const rows = [...document.querySelectorAll('.om-eval-panel .om-eval-row, .om-eval-panel button')];
    const row = rows.find(e => (e.textContent || '').includes('claude-mock'));
    if (!row) return 'NO_MODEL_ROW';
    row.click();
    return 'PICKED';
  })()`);
  console.log('pick model:', pick);
  await new Promise((r) => setTimeout(r, 800));
  const efforts = await page.ev(
    `(() => { const p = document.querySelector('.om-eval-panel'); return p ? [...p.querySelectorAll('.om-eval-right button, .om-eval-right [role=radio]')].map(e => (e.textContent || '').trim()).join(',') : 'NO_PANEL'; })()`,
  );
  console.log('efforts:', efforts);
  const pickE = await page.ev(`(() => {
    const els = [...document.querySelectorAll('.om-eval-panel .om-eval-right button, .om-eval-panel .om-eval-right [role=radio]')];
    const e = els.find(x => (x.textContent || '').trim().toLowerCase().endsWith('low'));
    if (!e) return 'NO_EFFORT';
    e.click();
    return 'PICKED';
  })()`);
  console.log('pick effort:', pickE);
  await new Promise((r) => setTimeout(r, 400));
  const start = await page.ev(
    `(() => { const b = document.querySelector('.om-eval-start'); if (!b) return 'NO_START'; b.click(); return 'CLICKED:' + b.textContent; })()`,
  );
  console.log('start:', start);
  await new Promise((r) => setTimeout(r, 6000));
  const after = await page.ev(`(() => {
    const txt = document.body.innerText;
    return JSON.stringify({
      panelGone: document.querySelector('.om-eval-panel') === null,
      evalPrompt: txt.includes('分析会话') && txt.includes('session_id omtest-imm'),
      model: [...document.querySelectorAll('button')].map(x => (x.textContent || '').replace(/s+/g, ' ').trim()).filter(t => t.length < 30 && /claude-mock|mock-model/.test(t)).join('|'),
      head: txt.slice(0, 400),
    });
  })()`);
  console.log('after:', after);
  await page.shot('evaljump');
  process.exit(0);
}

// —— 插件页三行结构探测：dump 相关 aria-label 与正文（拆分验证用）——
async function rowdump() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('sidebar:', await page.ev(clickByText('button', '打开侧边栏')));
  await new Promise((r) => setTimeout(r, 800));
  console.log('plugins:', await page.ev(clickByText('button', '插件')));
  await new Promise((r) => setTimeout(r, 2000));
  console.log('refresh:', await page.ev(clickByText('button', '刷新')));
  await new Promise((r) => setTimeout(r, 4000));
  const dump = await page.ev(`(() => {
    const labels = [...document.querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute('aria-label'))
      .filter((l) => /查看|配置|启用|停用|om|压缩|重压缩|评估/i.test(l));
    const switches = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')]
      .map((el) => (el.getAttribute('aria-label') || el.id || '?') + '=' + (el.getAttribute('aria-checked') ?? el.checked));
    return JSON.stringify({ labels, switches, text: document.body.innerText.slice(0, 3500) }, null, 1);
  })()`);
  console.log(dump);
  await page.shot('rowdump');
  process.exit(0);
}

// —— bundle 详情三行探测：行标题、开关、配置按钮（拆分验证用）——
async function bundleprobe() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 800));
  await page.ev(clickByText('button', '插件'));
  await new Promise((r) => setTimeout(r, 2000));
  await page.ev(clickByText('button', '刷新'));
  await new Promise((r) => setTimeout(r, 3500));
  console.log(
    'detail:',
    await page.ev(`(() => {
      const b = [...document.querySelectorAll('button[aria-label]')].find(
        (x) => x.getAttribute('aria-label') === '查看 OM风格的上下文管理',
      );
      if (!b) return 'NO_BTN';
      b.scrollIntoView({ block: 'center' });
      b.click();
      return 'CLICKED';
    })()`),
  );
  await new Promise((r) => setTimeout(r, 3000));
  const dump = await page.ev(`(() => {
    const labels = [...document.querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute('aria-label'))
      .filter((l) => !/会话/.test(l));
    const switches = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')]
      .map((el) => (el.getAttribute('aria-label') || '?') + '=' + (el.getAttribute('aria-checked') ?? el.checked));
    return JSON.stringify({ labels, switches, text: document.body.innerText.slice(0, 4000) }, null, 1);
  })()`);
  console.log(dump);
  await page.shot('bundleprobe');
  process.exit(0);
}

// —— 三行配置页逐行核查：字段、summary、返回（拆分验证用）——
async function rowcfg() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 800));
  await page.ev(clickByText('button', '插件'));
  await new Promise((r) => setTimeout(r, 2000));
  await page.ev(clickByText('button', '刷新'));
  await new Promise((r) => setTimeout(r, 3500));
  await page.ev(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(
      (x) => x.getAttribute('aria-label') === '查看 OM风格的上下文管理',
    );
    b.scrollIntoView({ block: 'center' });
    b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  for (const title of ['OM风格的上下文管理']) {
    const opened = await page.ev(`((t) => {
      const b = [...document.querySelectorAll('button[aria-label]')].find(
        (x) => x.getAttribute('aria-label') === '配置 ' + t,
      );
      if (!b) return 'NO_BTN';
      b.scrollIntoView({ block: 'center' });
      b.click();
      return 'CLICKED';
    })(${JSON.stringify(title)})`);
    await new Promise((r) => setTimeout(r, 2200));
    const dump = await page.ev(`((t) => {
      const txt = document.body.innerText;
      const labels = [...document.querySelectorAll('label')]
        .map((l) => (l.textContent || '').trim())
        .filter(Boolean);
      const inputs = document.querySelectorAll('input').length;
      return JSON.stringify({ title: t, opened: txt.includes(t), labels, inputs, head: txt.slice(0, 900) }, null, 1);
    })(${JSON.stringify(title)})`);
    console.log('opened:', opened);
    console.log(dump);
    await page.shot('rowcfg-' + title.replace(/\s/g, ''));
    const back = await page.ev(`(() => {
      const b = [...document.querySelectorAll('button[aria-label],button')].find(
        (x) => /返回/.test(x.getAttribute('aria-label') || x.textContent || ''),
      );
      if (!b) return 'NO_BACK';
      b.click();
      return 'BACK';
    })()`);
    await new Promise((r) => setTimeout(r, 1800));
    console.log('back:', back);
  }
  process.exit(0);
}

// —— 行配置写入落盘核查：包根行保存重压缩并发数后 profile patch 落盘（拆分验证用）——
async function rowwrite() {
  const { readFileSync } = await import('node:fs');
  const PATCH = 'C:/Users/admin/.dsh/profiles/om-test-components/cordis.patch.yml';
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '打开侧边栏'));
  await new Promise((r) => setTimeout(r, 800));
  await page.ev(clickByText('button', '插件'));
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(clickByText('button', '刷新'));
  await new Promise((r) => setTimeout(r, 3500));
  await page.ev(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(
      (x) => x.getAttribute('aria-label') === '查看 OM风格的上下文管理',
    );
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  await page.ev(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(
      (x) => x.getAttribute('aria-label') === '配置 OM风格的上下文管理',
    );
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const edit = await page.ev(`(() => {
    const labels = [...document.querySelectorAll('label,span,div,p')].filter(
      (x) => (x.textContent || '').trim() === '重压缩并发数',
    );
    if (!labels.length) return 'NO_LABEL';
    let scope = labels[0];
    for (let i = 0; i < 6 && scope; i++) { scope = scope.parentElement; if (scope && scope.querySelector('input')) break; }
    const input = scope && scope.querySelector('input');
    if (!input) return 'NO_INPUT';
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(input, '3');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'EDITED:' + input.value;
  })()`);
  console.log('edit:', edit);
  await new Promise((r) => setTimeout(r, 800));
  const save = await page.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '保存修改');
    if (!b || b.disabled) return 'NO_SAVE';
    b.click();
    return 'SAVED';
  })()`);
  console.log('save:', save);
  await new Promise((r) => setTimeout(r, 2500));
  const patch1 = readFileSync(PATCH, 'utf8');
  console.log(
    'patch has value:',
    /recompressConcurrency:\s*3/.test(patch1),
    'no recompress row:',
    !patch1.includes('dsh-plugin-om-recompress'),
  );
  const revert = await page.ev(`(() => {
    const btns = [...document.querySelectorAll('button')].filter((x) => (x.textContent || '').trim() === '恢复默认');
    if (!btns.length) return 'NO_RESET';
    btns[0].click();
    return 'RESET';
  })()`);
  console.log('reset:', revert);
  await new Promise((r) => setTimeout(r, 800));
  const save2 = await page.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '保存修改');
    if (!b || b.disabled) return 'NO_SAVE';
    b.click();
    return 'SAVED';
  })()`);
  console.log('save2:', save2);
  await new Promise((r) => setTimeout(r, 2500));
  const patch2 = readFileSync(PATCH, 'utf8');
  console.log('patch after revert has value:', /recompressConcurrency:\s*3/.test(patch2));
  await page.shot('rowwrite');
  process.exit(0);
}

// —— 评估行门控：关闭评估组件行后裸调用不弹模型面板（拆分验证用）——
async function evalgating() {
  const page = await connect(GUI);
  const gotoDetail = async () => {
    await waitLoad(page);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.ev(clickByText('button', '打开侧边栏'));
      await new Promise((r) => setTimeout(r, 800));
      await page.ev(clickByText('button', '插件'));
      await new Promise((r) => setTimeout(r, 2500));
      await page.ev(clickByText('button', '刷新'));
      await new Promise((r) => setTimeout(r, 3500));
      const d = await page.ev(`(() => {
        const b = [...document.querySelectorAll('button[aria-label]')].find(
          (x) => x.getAttribute('aria-label') === '查看 OM风格的上下文管理',
        );
        if (!b) return 'NO_DETAIL_BTN';
        b.scrollIntoView({ block: 'center' });
        b.click();
        return 'CLICKED';
      })()`);
      await new Promise((r) => setTimeout(r, 2500));
      if (d === 'CLICKED') return d;
      const inDetail = await page.ev(`(() => {
        const el = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')].find(
          (x) => (x.getAttribute('aria-label') || '') === '启用组件 OM 结果评估',
        );
        return el ? 'IN_DETAIL' : 'NO_SWITCH';
      })()`);
      if (inDetail === 'IN_DETAIL') return 'ALREADY_IN_DETAIL';
    }
    return 'NO_DETAIL_BTN';
  };
  const setSwitch = async (label, want) => {
    for (let i = 0; i < 6; i++) {
      const cur = await page.ev(`((l) => {
        const el = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')].find(
          (x) => (x.getAttribute('aria-label') || '') === l,
        );
        if (!el) return 'NO_SWITCH';
        return String(el.getAttribute('aria-checked') ?? el.checked);
      })(${JSON.stringify(label)})`);
      if (cur === 'NO_SWITCH') return 'NO_SWITCH';
      if (cur === String(want)) return 'OK';
      await page.ev(`((l) => {
        const el = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')].find(
          (x) => (x.getAttribute('aria-label') || '') === l,
        );
        el.scrollIntoView({ block: 'center' });
        el.click();
      })(${JSON.stringify(label)})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    return 'TIMEOUT';
  };
  const probePanel = async () => {
    await page.send('Page.reload', {});
    await new Promise((r) => setTimeout(r, 6000));
    await openCard(page);
    const ed = await page.ev(`(() => {
      const els = [...document.querySelectorAll('[contenteditable="true"], textarea, [role=textbox]')].filter(e => { const r = e.getBoundingClientRect(); return r.height > 20 && r.width > 200; });
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!ed) return 'NO_COMPOSER';
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: ed.x,
      y: ed.y,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: ed.x,
      y: ed.y,
      button: 'left',
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 500));
    const key = (type, k, code, vk, mods) =>
      page.send(
        'Input.dispatchKeyEvent',
        Object.assign(
          {
            type,
            key: k,
            code,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers: mods || 0,
          },
          type === 'char' ? { text: k } : {},
        ),
      );
    await key('keyDown', '/', 'Slash', 191);
    await key('char', '/', 'Slash', 191);
    await key('keyUp', '/', 'Slash', 191);
    await new Promise((r) => setTimeout(r, 1200));
    await page.send('Input.insertText', { text: 'om-compaction-eval' });
    await new Promise((r) => setTimeout(r, 800));
    const catalog = await page.ev(`(() => {
      const items = [...document.querySelectorAll('[role="option"],[role="menuitem"],[cmdk-item],li')];
      return JSON.stringify(items.map((e) => (e.textContent || '').trim().slice(0, 60)).filter((t) => t.includes('om-compaction-eval')));
    })()`);
    console.log('catalog match:', catalog);
    await key('keyDown', 'Enter', 'Enter', 13);
    await key('keyUp', 'Enter', 'Enter', 13);
    await new Promise((r) => setTimeout(r, 2500));
    const panel = await page.ev(
      `(() => (document.querySelector('.om-eval-panel') ? 'PANEL_PRESENT' : 'PANEL_ABSENT'))()`,
    );
    return panel;
  };
  console.log('detail:', await gotoDetail());
  console.log('eval off:', await setSwitch('启用组件 OM 结果评估', false));
  console.log('panel after off:', await probePanel());
  await page.shot('evalgating-off');
  console.log('detail2:', await gotoDetail());
  console.log('eval on:', await setSwitch('启用组件 OM 结果评估', true));
  process.exit(0);
}

// —— 临时探针：dump 页面文本与侧边栏树行（环境排查用）——
async function pagetext() {
  const page = await connect(GUI);
  await waitLoad(page);
  await new Promise((r) => setTimeout(r, 3000));
  const out = await page.ev(`(() => {
    const items = [...document.querySelectorAll('[role="treeitem"], [class*="projectRow"]')].map(
      (e) => (e.textContent || '').trim().slice(0, 80),
    );
    return JSON.stringify({ body: document.body.innerText.slice(0, 1200), items }, null, 1);
  })()`);
  console.log(out);
  process.exit(0);
}
