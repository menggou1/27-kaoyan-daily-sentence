// Real Edge lifecycle and HTTP cache. Run headed, in an isolated temporary profile.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
const liveApi = 'https://utctime.app/api/now';
const oldHtml = live ? null : execFileSync('git', ['show', '402c40c:index.html'], {cwd:root, encoding:'utf8'});
const newHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mime = {'.js':'text/javascript', '.css':'text/css', '.txt':'text/plain; charset=utf-8', '.ttf':'font/ttf', '.svg':'image/svg+xml'};
const hour = 3600000;
// Observe the JSON the real fetch delivered. No request interception or cache overrides.
const probe = `<script>(${function () {
  const fetchTime = window.fetch.bind(window);
  const json = Response.prototype.json;
  window.clockResponses = [];
  window.clockRequests = [];
  window.fetch = (input, options) => {
    const url = new URL(input, location.href);
    if (url.pathname === '/api/now' && options?.signal) {
      clockRequests.push({url:url.href, started:Date.now(), signal:options.signal});
    }
    return fetchTime(input, options);
  };
  Response.prototype.json = async function () {
    const body = await json.call(this);
    if (new URL(this.url, location.href).pathname === '/api/now') {
      clockResponses.push({ url:this.url, status:this.status, unix_ms:body.unix_ms,
        responseId:this.headers.get('x-response-id'), date:this.headers.get('date'), received:Date.now() });
    }
    return body;
  };
}})();</script>`;
let mode = 'fresh';
let origin;
const hits = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, origin).pathname;
  if (pathname === '/api/now') {
    const received = Date.now();
    const hit = { id:hits.length + 1, url:req.url, received, unix_ms:received - (mode === 'stale' ? 5 * hour : 0), mode };
    hits.push(hit);
    if (mode === 'timeout') {
      res.on('close', () => { hit.closed = Date.now(); });
      return; // The browser must cancel this outstanding request.
    }
    res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'public, max-age=1', 'X-Response-Id':hit.id });
    res.end(JSON.stringify({ unix_ms:hit.unix_ms }));
    return;
  }
  if (pathname === '/' || pathname === '/baseline') {
    const html = pathname === '/baseline' ? oldHtml : newHtml;
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
    res.end((live ? html : html.replace(liveApi, origin + '/api/now')).replace('<head>', '<head>' + probe));
    return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (error, content) => {
    if (error) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
});

async function poll(callback, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open', {signal:AbortSignal.timeout(10000)});
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  });
  return async (method, params = {}, sessionId) => {
    const call = ++id;
    try {
      const message = await new Promise((resolve, reject) => {
        pending.set(call, resolve);
        socket.send(JSON.stringify({id:call, method, params, sessionId}));
        AbortSignal.timeout(10000).addEventListener('abort', () => reject(new Error(`CDP timeout: ${method}`)), {once:true});
      });
      assert.ok(!message.error, JSON.stringify(message.error));
      return message.result;
    } finally { pending.delete(call); }
  };
}

async function withTarget(cdp, targetId, run) {
  const {sessionId} = await cdp('Target.attachToTarget', {targetId, flatten:true});
  try { return await run(sessionId); }
  finally { await cdp('Target.detachFromTarget', {sessionId}); }
}

async function evaluate(cdp, targetId, expression) {
  return withTarget(cdp, targetId, async sessionId => {
    const result = await cdp('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true}, sessionId);
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  });
}

const snapshot = `window.KaoyanExtras && document.readyState === 'complete' && ({
  captured:Date.now(), discarded:document.wasDiscarded, timeOrigin:performance.timeOrigin,
  navigation:performance.getEntriesByType('navigation')[0].type,
  clock:window.KaoyanExtras.now(), status:document.querySelector('#clock-status').textContent,
  date:document.querySelector('#date').textContent, responses:window.clockResponses,
  requests:window.clockRequests.map(({signal, ...request}) => ({...request, aborted:signal.aborted})),
  completed:performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/now')).length
})`;

async function discard(cdp, page, controls, url) {
  const before = await evaluate(cdp, page, snapshot);
  const tabs = async () => (await cdp('Target.getTargets', {filter:[{type:'tab'}]})).targetInfos;
  const tab = (await tabs()).find(target => target.url === url);
  assert.ok(Number.isInteger(tab?.embedderData?.tabStripIndex));
  const row = `(() => {
    const table = document.querySelector('discards-main')?.shadowRoot?.querySelector('discards-tab')?.shadowRoot;
    return [...(table?.querySelectorAll('tr') || [])].find(row => [...row.cells].some(cell => cell.textContent.trim() === ${JSON.stringify(url)}));
  })()`;
  await cdp('Target.activateTarget', {targetId:controls});
  await poll(() => evaluate(cdp, controls, `(() => {
    const action = [...(${row})?.querySelectorAll('action-link, [is="action-link"]') || []]
      .find(link => link.textContent.trim() === '[Urgent Discard]');
    if (!action || action.hasAttribute('disabled')) return false;
    action.click();
    return true;
  })()`), 'enabled Edge discard action');
  await poll(() => evaluate(cdp, controls, `(${row})?.innerText.includes('discarded')`), 'discarded tab');
  // Edge replaces the DevTools targets on discard. The slot in the same tab strip survives.
  const restoredTarget = (await tabs()).find(target => target.browserContextId === tab.browserContextId
    && target.embedderData?.tabStripIndex === tab.embedderData.tabStripIndex);
  assert.ok(restoredTarget);
  await cdp('Target.activateTarget', {targetId:restoredTarget.targetId});
  await delay(400);
  return before.timeOrigin;
}

function networkLog(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const types = log.constants.logEventTypes;
  const requests = new Map();
  for (const event of log.events) {
    if (event.type === types.URL_REQUEST_START_JOB && event.params?.url?.includes('/api/now')) {
      requests.set(event.source.id, { url:event.params.url, flags:event.params.load_flags, events:[], date:undefined });
    }
    const request = requests.get(event.source.id);
    if (!request) continue;
    request.events.push(event.type);
    const headers = event.params?.headers;
    if (Array.isArray(headers)) request.date ||= headers.find(header => /^date:/i.test(header));
  }
  return [...requests.values()].map(({events, ...request}) => ({...request,
    sent:events.includes(types.HTTP_TRANSACTION_SEND_REQUEST), cacheRead:events.includes(types.HTTP_CACHE_READ_DATA)
  }));
}

const rounds = [];
const sandbox = fs.realpathSync(os.tmpdir());
const profile = fs.mkdtempSync(path.join(sandbox, 'kaoyan-edge-'));
const logFile = path.join(profile, 'netlog.json');
const artifacts = process.env.TEST_ARTIFACTS;
let browser;
let cdp;
let page;
let controls;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const edge = process.env.BROWSER_EXECUTABLE || path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.ok(fs.existsSync(edge), `Microsoft Edge executable unavailable: ${edge}`);
  browser = spawn(edge, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', `--log-net-log=${logFile}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], {stdio:'ignore'});
  const portFile = path.join(profile, 'DevToolsActivePort');
  const [port, endpoint] = await poll(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().split('\n'), 'Edge CDP socket');
  cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
  console.log(JSON.stringify(await cdp('Browser.getVersion')));
  ({targetId:controls} = await cdp('Target.createTarget', {url:'edge://discards/'}));
  let url = origin + (live ? '/' : '/baseline');
  ({targetId:page} = await cdp('Target.createTarget', {url}));
  const read = async (label, status, before, start) => {
    const result = await poll(async () => {
      const found = (await cdp('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url === url);
      if (!found) return;
      page = found.targetId;
      const state = await evaluate(cdp, page, snapshot);
      if (state?.requests?.length && state.completed >= state.requests.length && state.status.includes(status)
        && (!before || state.timeOrigin !== before)) return state;
    }, label);
    if (before) assert.ok(result.discarded && result.navigation === 'back_forward', JSON.stringify(result));
    rounds.push({label, ...result, hits:hits.slice(start)});
    console.log(JSON.stringify(rounds.at(-1)));
    return result;
  };
  await read(live ? 'live initial, empty cache' : 'baseline initial', '已网络校时', null, 0);
  if (!live) {
    const warm = async label => {
      const seed = await evaluate(cdp, page, `fetch('/api/now', {cache:'reload'}).then(async response => ({
        id:response.headers.get('x-response-id'), unix_ms:(await response.json()).unix_ms
      }))`);
      await delay(1500);
      mode = 'fresh';
      const start = hits.length;
      const replay = await read(label, '已网络校时', await discard(cdp, page, controls, url), start);
      assert.equal(hits.length, start);
      assert.ok(replay.responses.length >= 2 && replay.responses.every(body => body.status === 200
        && body.unix_ms === seed.unix_ms && body.responseId === seed.id));
      return {replay, start};
    };
    const normal = await warm('baseline expired normal response');
    assert.ok(normal.replay.captured - normal.replay.clock > 1000);
    mode = 'stale';
    const {replay, start} = await warm('baseline five-hour replay');
    assert.ok(Math.abs(replay.captured - replay.clock - 5 * hour) < 10000);
    await cdp('Target.closeTarget', {targetId:page});
    url = origin + '/';
    ({targetId:page} = await cdp('Target.createTarget', {url}));
    await read('fixed initial with stale cache', '已网络校时', null, start);
  }
  for (let i = 1; i <= 3; i++) {
    const start = hits.length;
    await read(`${live ? 'live' : 'fixed'} discard ${i}`, '已网络校时', await discard(cdp, page, controls, url), start);
  }
  if (!live) {
    mode = 'timeout';
    const start = hits.length;
    const fallback = await read('fixed restore timeout', '本地时间', await discard(cdp, page, controls, url), start);
    assert.equal(fallback.responses.length, 0);
    assert.ok(hits.length > start && hits.slice(start).every(hit => hit.mode === 'timeout' && hit.closed - hit.received >= 4000));
    assert.ok(fallback.requests.every(request => request.aborted));
    assert.ok(Math.abs(fallback.captured - fallback.clock) < 5000);
    mode = 'fresh';
    const retry = hits.length;
    await evaluate(cdp, page, `window.dispatchEvent(new Event('online'))`);
    const recovered = await read('fixed retry after timeout', '已网络校时', null, retry);
    assert.equal(recovered.timeOrigin, fallback.timeOrigin);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (browser?.pid && browser.exitCode === null) {
      if (artifacts && cdp) {
        fs.mkdirSync(artifacts, {recursive:true});
        for (const [name, target] of [['page', page], ['discards', controls]]) {
          if (!target) continue;
          try {
            const screenshot = await withTarget(cdp, target, session => cdp('Page.captureScreenshot', {}, session));
            fs.writeFileSync(path.join(artifacts, `edge-${name}.png`), Buffer.from(screenshot.data, 'base64'));
          } catch (captureError) { console.error(captureError.message); }
        }
      }
      const exited = once(browser, 'exit');
      if (cdp) await cdp('Browser.close');
      else browser.kill();
      await exited;
    }
    if (fs.existsSync(logFile)) {
      const network = networkLog(logFile);
      console.log(JSON.stringify({network}));
      if (artifacts) {
        fs.mkdirSync(artifacts, {recursive:true});
        fs.writeFileSync(path.join(artifacts, 'edge-network.json'), JSON.stringify({rounds, network}, null, 2));
      }
      if (process.exitCode) return;
      const seen = new Set();
      for (const result of rounds.filter(round => /^(live|fixed)/.test(round.label) && !round.label.endsWith('timeout'))) {
        assert.ok(result.responses.length > 0 && Math.abs(result.captured - result.clock) < 5000);
        for (const response of result.responses) {
          assert.equal(response.status, 200);
          assert.ok(!seen.has(response.url) && new URL(response.url).searchParams.has('_sync'));
          seen.add(response.url);
          assert.ok(Number.isSafeInteger(response.unix_ms) && Math.abs(response.received - response.unix_ms) < 5000);
          const matching = network.filter(entry => entry.url === response.url);
          assert.equal(matching.length, 1);
          assert.ok(matching[0].sent && !matching[0].cacheRead, JSON.stringify(matching[0]));
          if (!live) assert.ok(result.hits.some(hit => hit.id === Number(response.responseId) && hit.unix_ms === response.unix_ms));
        }
        if (!live) assert.equal(result.hits.length, result.responses.length);
      }
      if (!live) {
        const replays = network.filter(entry => entry.url === origin + '/api/now' && entry.cacheRead && !entry.sent);
        assert.ok(replays.length >= 2);
      }
    }
  } finally {
    server.close();
    // Only delete the isolated directory created by this run, never an Edge user profile.
    assert.equal(fs.realpathSync(profile), profile);
    assert.equal(path.dirname(profile), sandbox);
    fs.rmSync(profile, {recursive:true, force:true, maxRetries:5, retryDelay:100});
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
