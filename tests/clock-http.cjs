// Local HTTP plus an explicit replay cache, without a discard or a Playwright route.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sessionWithEvidence = require('./browser-evidence.cjs');

const root = path.resolve(__dirname, '..');
const start = Date.parse('2026-10-08T23:59:50+08:00');
const exam = Date.parse('2026-12-19T08:30:00+08:00');
const oldTime = start - 5 * 3600000;
let nextTime = start;
let timeout = false;
const hits = [];

exports.handle = function handle(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/now') {
    const hit = {id:hits.length + 1, url:req.url, at:Date.now(), unix_ms:nextTime, timeout};
    hits.push(hit);
    if (timeout) {
      res.on('close', () => { hit.closed = Date.now(); });
      return true;
    }
    res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'public, max-age=1', 'X-Response-Id':hit.id});
    res.end(JSON.stringify({unix_ms:hit.unix_ms}));
    return true;
  }
  if (pathname === '/clock-fixed.html' || pathname === '/clock-legacy.html') {
    const html = pathname === '/clock-legacy.html'
      ? execFileSync('git', ['show', '402c40c:index.html'], {cwd:root, encoding:'utf8'})
      : fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(html.replace('https://utctime.app/api/now', '/api/now'));
    return true;
  }
  return false;
};

exports.check = async function clockHttpChecks(browser, origin, check) {
  await sessionWithEvidence(browser, 'clock-http', {timezoneId:'UTC'}, async context => {
    await context.addInitScript(() => {
      const realFetch = fetch.bind(window);
      const json = Response.prototype.json;
      window.clockHttp = [];
      window.fetch = (input, options) => {
        if (input.startsWith('/api/now') && options?.signal && location.search === '?emulate-cache') {
          return caches.match(input, {cacheName:'clock-fixture'}).then(cached => cached || realFetch(input, options));
        }
        return realFetch(input, options);
      };
      Response.prototype.json = async function () {
        const body = await json.call(this);
        if (this.url && new URL(this.url).pathname === '/api/now') {
          clockHttp.push({url:this.url, status:this.status, id:Number(this.headers.get('x-response-id')), unix_ms:body.unix_ms});
        }
        return body;
      };
    });
    const page = await context.newPage();
    const status = text => page.waitForFunction(text => document.querySelector('#clock-status')?.textContent.includes(text), text);
    const clock = () => page.evaluate(() => ({ now:window.KaoyanExtras.now(), tick:performance.now(), origin:performance.timeOrigin }));
    const observed = () => page.evaluate(() => clockHttp);
    const sync = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
    try {
      await page.goto(origin + '/clock-fixed.html');
      await status('已网络校时');
      const cold = (await observed())[0];
      check('Cold HTTP sync gets a fresh 200 from the local server', cold.status === 200 && cold.unix_ms === start
        && hits.some(hit => hit.id === cold.id) && Math.abs((await clock()).now - start) < 1500);

      nextTime = oldTime;
      const seeded = await page.evaluate(async () => {
        const response = await fetch('/api/now', {cache:'reload'});
        const cache = await caches.open('clock-fixture');
        await cache.put('/api/now', response.clone());
        return {id:Number(response.headers.get('x-response-id')), unix_ms:(await response.json()).unix_ms};
      });
      await page.waitForTimeout(1500); // The HTTP max-age is one second.
      assert.equal(seeded.unix_ms, oldTime);
      nextTime = start;
      const beforeReplay = hits.length;
      await page.goto(origin + '/clock-legacy.html?emulate-cache');
      await status('已网络校时');
      const count = (await observed()).length;
      await sync();
      await page.waitForFunction(count => clockHttp.length > count, count);
      const replayed = await observed();
      check('Emulated restored cache produces at least two stale 200s from one saved HTTP response and no new server request',
        replayed.length >= 2 && replayed.every(response => response.status === 200 && response.id === seeded.id && response.unix_ms === oldTime)
        && hits.length === beforeReplay && Math.abs((await clock()).now - oldTime) < 1500);

      await page.goto(origin + '/clock-fixed.html?emulate-cache');
      await status('已网络校时');
      const fixed = await observed();
      check('Fixed client bypasses the same five-hour stale cache under the emulated restore policy',
        fixed.length > 0 && fixed.every(response => response.status === 200 && response.unix_ms === start
          && new URL(response.url).searchParams.has('_sync')
          && hits.slice(beforeReplay).some(hit => hit.id === response.id && hit.url === new URL(response.url).pathname + new URL(response.url).search))
        && Math.abs((await clock()).now - start) < 1500);
      check('Date starts on the pre-midnight Beijing day', await page.locator('#date').textContent() === '10-08');

      const beforeTimeout = await clock();
      timeout = true;
      await sync();
      await status('网络校时保持中');
      const aborted = hits.find(hit => hit.timeout);
      const held = await clock();
      check('Timeout aborts a real HTTP request and the previous clock keeps advancing',
        aborted?.closed - aborted?.at >= 4000 && Math.abs((held.now - beforeTimeout.now) - (held.tick - beforeTimeout.tick)) < 20);

      timeout = false;
      nextTime = start + 20000;
      await sync();
      await status('已网络校时');
      await page.waitForFunction(() => document.querySelector('#midnight-label').textContent.includes('10 月 10 日'));
      const midnight = await page.evaluate(() => ({
        now:window.KaoyanExtras.now(), origin:performance.timeOrigin, date:document.querySelector('#date').textContent,
        exam:[...document.querySelector('#countdown').childNodes].filter(node => node.nodeType === 3)
          .reduce((seconds, node, index) => seconds + Number(node.textContent) * [86400, 3600, 60, 1][index], 0),
        daily:document.querySelector('#midnight-countdown').textContent.split(':').reduce((seconds, part) => 60 * seconds + Number(part), 0)
      }));
      check('Successful retry in the same document updates the Beijing date across midnight',
        midnight.origin === beforeTimeout.origin && midnight.date === '10-09' && Math.abs(midnight.now - nextTime) < 1500);
      const nextMidnight = Date.parse('2026-10-10T00:00:00+08:00');
      check('Exam and midnight countdowns agree with the same network time',
        Math.abs(midnight.exam - Math.ceil((exam - midnight.now) / 1000)) <= 1
        && Math.abs(midnight.daily - Math.ceil((nextMidnight - midnight.now) / 1000)) <= 1);
    } catch (error) {
      console.error(JSON.stringify({hits, responses:await observed().catch(() => [])}));
      throw error;
    }
  });
};
