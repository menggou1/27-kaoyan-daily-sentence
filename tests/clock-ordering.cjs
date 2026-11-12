// Deterministic regression checks against the actual page scripts. Node.js 18+;
// no dependencies, network, real waits, or browser clock changes are required.
// The DOM stand-in records output only; this does not test browser scheduling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const code = file => baseline
  ? execFileSync('git', ['show', `HEAD:${file}`], { cwd:root, encoding:'utf8' })
  : fs.readFileSync(path.join(root, file), 'utf8');
const HOUR = 3600000;
const START = Date.parse('2026-10-08T23:00:00+08:00');
const EXAM = Date.parse('2026-12-19T08:30:00+08:00');

class Element extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.attributes = new Map();
    this.children = [];
    this.textContent = '';
    this.innerHTML = '';
    this.open = false;
    const names = new Set();
    this.classList = {
      add(...values) { values.forEach(value => names.add(value)); },
      remove(...values) { values.forEach(value => names.delete(value)); },
      contains(value) { return names.has(value); },
      toggle(value, force = !names.has(value)) { if (force) names.add(value); else names.delete(value); return force; }
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  get childElementCount() { return this.children.length; }
  contains() { return false; }
  closest() { return new Element(); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function createPage({ hidden = false, wallOffset = 0, offline = false } = {}) {
  const state = {
    wall:START + wallOffset, tick:1000, server:START,
    hold:false, offline, intervals:[], pending:[], requests:0
  };
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = Object.assign(new EventTarget(), {
    hidden, activeElement:null, documentElement:new Element(),
    getElementById:get, querySelector:get, querySelectorAll:() => [],
    createElement:() => new Element(), createElementNS:() => new Element(),
    createDocumentFragment:() => new Element()
  });
  const sandbox = Object.assign(new EventTarget(), {
    document, console, Event, AbortController, TextDecoder,
    Date:class extends Date { static now() { return state.wall; } },
    performance:{ now:() => state.tick },
    localStorage:{ getItem:() => null },
    atob:value => Buffer.from(value, 'base64').toString('binary'),
    requestAnimationFrame:callback => { callback(state.tick); return 1; },
    setInterval:(callback, ms) => state.intervals.push({ callback, ms }),
    setTimeout:() => 1, clearTimeout:() => {},
    matchMedia:() => Object.assign(new EventTarget(), { matches:true }),
    fetch:input => {
      if (input !== 'https://utctime.app/api/now') {
        return Promise.resolve(new Response(fs.readFileSync(path.resolve(root, input))));
      }
      state.requests++;
      if (state.offline) return Promise.reject(new TypeError('Offline'));
      if (state.hold) return new Promise(resolve => state.pending.push(resolve));
      return Promise.resolve(new Response(JSON.stringify({ unix_ms:state.server })));
    }
  });
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const match of code('index.html').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], context, { filename:'index.html' });
  }
  for (const file of ['extras.js', 'calendar.js']) {
    vm.runInContext(code(file), context, { filename:file });
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  assert.match(get('clock-status').textContent, offline ? /本地时间/ : /已网络校时/);
  return { state, sandbox, get, document, flush, now:() => sandbox.KaoyanExtras.now() };
}

function hide(page) {
  page.document.hidden = true;
  page.document.dispatchEvent(new Event('visibilitychange'));
}
function show(page) {
  page.document.hidden = false;
  page.document.dispatchEvent(new Event('visibilitychange'));
}
function sleep(page, ticking = false) {
  page.state.wall += 5 * HOUR + 250;
  page.state.server += 5 * HOUR + 250;
  page.state.tick += ticking ? 5 * HOUR + 250 : 250;
}
function examSeconds(page) {
  const values = page.get('countdown').innerHTML.match(/\d+(?=<small>)/g).map(Number);
  return values.reduce((total, value, index) => total + value * [86400, 3600, 60, 1][index], 0);
}
const checks = [];
function check(name, passed, details) { checks.push({ name, passed, ...(details ? { details } : {}) }); }
const readers = [
  ['exam timer', page => page.state.intervals[0].callback()],
  ['daily timer', page => page.state.intervals[1].callback()],
  ['calendar timer', page => page.state.intervals[2].callback()],
  ['shared clock reader', page => page.now()]
];

(async () => {
  for (const timing of ['while hidden', 'visible before visibilitychange']) {
    for (const [reader, read] of readers) {
      const page = await createPage();
      hide(page);
      page.state.hold = true;
      sleep(page);
      if (timing === 'visible before visibilitychange') page.document.hidden = false;
      read(page);
      show(page);
      const label = `${reader} first ${timing}`;
      const lag = page.state.server - page.now();
      check(`${label}: catches up before network response`, lag === 0, { lagMs:lag });
      check(`${label}: date and exam countdown update immediately`,
        page.get('date').textContent === '10-09' && examSeconds(page) === Math.ceil((EXAM - page.state.server) / 1000));
      check(`${label}: daily clock and calendar use recovered time`,
        page.get('midnight-countdown').textContent === '20:00:00' && page.get('selected-date').textContent === '2026.10.09');
      for (let i = 0; i < 20; i++) page.now();
      check(`${label}: repeated readers do not add sleep twice`, page.now() === page.state.server);
      page.sandbox.dispatchEvent(new Event('focus'));
      page.document.dispatchEvent(new Event('resume'));
      page.sandbox.dispatchEvent(new Event('pageshow'));
      check(`${label}: consecutive recovery events share one request`, page.state.pending.length === 1 && page.state.requests === 2);
      const beforeSync = page.now();
      page.state.pending.shift()(new Response(JSON.stringify({ unix_ms:page.state.server })));
      await page.flush();
      check(`${label}: successful sync has no hours-long jump`, page.now() === beforeSync && page.now() === page.state.server);
      check(`${label}: crossing midnight also updates the daily quote`, page.get('sentence').textContent.includes('只要比昨天的自己多懂一点点'));
    }
  }

  for (const [reader, read] of readers) {
    const page = await createPage({ wallOffset:2 * HOUR });
    hide(page);
    page.state.offline = true;
    sleep(page);
    read(page);
    show(page);
    await page.flush();
    check(`${reader} first offline: keeps network offset and all five hours`,
      page.now() === page.state.server && page.get('clock-status').textContent.includes('保持中'));
  }

  const immediate = await createPage();
  hide(immediate);
  immediate.state.hold = true;
  sleep(immediate);
  show(immediate);
  check('Recovery event first still catches up immediately', immediate.now() === immediate.state.server);

  for (const change of [5 * HOUR, -5 * HOUR]) {
    const page = await createPage();
    page.state.hold = true;
    page.state.wall += change;
    page.state.intervals[0].callback();
    page.sandbox.dispatchEvent(new Event('focus'));
    check(`Active device clock change ${change}ms does not move network time`, page.now() === page.state.server);
  }

  const ticking = await createPage();
  hide(ticking);
  ticking.state.hold = true;
  sleep(ticking, true);
  ticking.state.intervals[0].callback();
  show(ticking);
  check('Ordinary backgrounding with an advancing monotonic clock is not counted twice', ticking.now() === ticking.state.server);

  const initiallyHidden = await createPage({ hidden:true });
  initiallyHidden.state.hold = true;
  sleep(initiallyHidden);
  initiallyHidden.document.hidden = false;
  initiallyHidden.state.intervals[0].callback();
  show(initiallyHidden);
  check('A page opened in a hidden tab also retains its recovery context', initiallyHidden.now() === initiallyHidden.state.server);

  const local = await createPage({ offline:true });
  hide(local);
  sleep(local);
  local.state.intervals[0].callback();
  show(local);
  check('Initial sync failure still falls back to the current local time', local.now() === local.state.wall);

  const simulated = await createPage();
  const simulationStart = Date.parse('2026-10-10T12:00:00+08:00');
  simulated.get('dev-time').value = '2026-10-10T12:00:00';
  simulated.get('dev-form').dispatchEvent(new Event('submit', { cancelable:true }));
  hide(simulated);
  simulated.state.hold = true;
  sleep(simulated);
  simulated.state.intervals[0].callback();
  show(simulated);
  check('Recovery does not change the independent simulated time anchor', simulated.now() === simulationStart + 250);

  const summary = { mode:baseline ? 'baseline HEAD' : 'working tree', passed:checks.filter(item => item.passed).length, total:checks.length, checks };
  console.log(JSON.stringify(summary, null, 2));
  if (checks.some(item => !item.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
