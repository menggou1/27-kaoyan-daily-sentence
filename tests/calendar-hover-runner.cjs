// Focused hover checks; use --baseline to compare the committed implementation.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const calendarHoverChecks = require('./calendar-hover.cjs');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const original = new Map(baseline ? ['calendar.js', 'extras.css'].map(file => [file, execFileSync('git', ['show', `HEAD:${file}`], {cwd:root})]) : []);
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.txt':'text/plain; charset=utf-8','.ttf':'font/ttf','.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  let file;
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  } catch (_) { res.writeHead(400).end(); return; }
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const send = (error, content) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'});
    res.end(content);
  };
  if (original.has(path.relative(root, file))) send(null, original.get(path.relative(root, file)));
  else fs.readFile(file, send);
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
  const page = await browser.newPage({viewport:{width:1100,height:900},timezoneId:'UTC'});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://utctime.app/api/now', route => route.fulfill({json:{unix_ms:Date.parse('2026-10-08T12:00:00+08:00')}}));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('#calendar-open').click();
  await page.waitForFunction(() => !document.getElementById('quote-copy').disabled);
  const results = [];
  await calendarHoverChecks(page, (name, passed) => {
    results.push({name,passed});
    if (!baseline) assert.ok(passed, name);
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({mode:baseline ? 'baseline' : 'current',passed:results.filter(result => result.passed).length,total:results.length,checks:results},null,2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
