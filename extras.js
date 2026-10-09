(function () {
  'use strict';
  const api = window.KaoyanExtras;
  if (!api) return;
  const front = document.getElementById('card-front');
  const back = document.getElementById('card-back');
  const card = front.closest('.card');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let flipping = false;

  async function flip(showBack) {
    if (flipping) return;
    flipping = true;
    let transition = null;
    try {
      if (!reducedMotion.matches && card.animate) {
        transition = card.animate([{ transform:'perspective(1400px) rotateY(0)' }, { transform:'perspective(1400px) rotateY(70deg)', opacity:.35 }], { duration:150, easing:'ease-in', fill:'forwards' });
        await transition.finished;
      }
      front.hidden = showBack;
      back.hidden = !showBack;
      updateDayClock();
      // Cancel filled transforms before laying out the newly visible face.
      if (transition) transition.cancel();
      if (!reducedMotion.matches && card.animate) {
        transition = card.animate([{ transform:'perspective(1400px) rotateY(-70deg)', opacity:.35 }, { transform:'perspective(1400px) rotateY(0)', opacity:1 }], { duration:180, easing:'ease-out' });
        await transition.finished;
      }
    } catch (_) {
      // Motion may be interrupted when the tab is hidden; retain the requested face.
      front.hidden = showBack;
      back.hidden = !showBack;
    } finally {
      if (transition) transition.cancel();
      (showBack ? document.getElementById('back-title') : document.getElementById('card-flip')).focus({ preventScroll:true });
      flipping = false;
    }
  }
  document.getElementById('card-flip').addEventListener('click', () => flip(true));
  document.getElementById('card-unflip').addEventListener('click', () => flip(false));

  const pad = value => String(value).padStart(2, '0');
  const dial = document.querySelector('.day-dial');
  const hands = ['clock-hour', 'clock-minute', 'clock-second'].map(id => document.getElementById(id));
  const ticks = document.getElementById('clock-ticks');
  for (let i = 0; i < 60; i++) {
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tick.setAttribute('d', 'M120 22V' + (i % 5 === 0 ? '30' : '26'));
    tick.setAttribute('transform', 'rotate(' + i * 6 + ' 120 120)');
    if (i % 5 === 0) tick.classList.add('major-tick');
    ticks.append(tick);
  }
  let dialDate = '';
  function updateDayClock() {
    const now = api.now();
    const key = api.dateKey(new Date(now));
    const start = Date.parse(key + 'T00:00:00+08:00');
    const midnight = start + 86400000;
    const left = Math.max(0, Math.ceil((midnight - now) / 1000));
    const remaining = Math.max(0, midnight - now);
    const percent = Math.max(0, Math.min(100, remaining / 864000));
    document.getElementById('midnight-countdown').textContent = [Math.floor(left / 3600), Math.floor(left / 60) % 60, left % 60].map(pad).join(':');
    document.getElementById('midnight-label').textContent = '距离 ' + api.dateKey(new Date(midnight)).slice(5).replace('-', ' 月 ') + ' 日 00:00 · 北京时间';
    document.getElementById('day-percent').textContent = '今日剩余 ' + percent.toFixed(1) + '%';
    document.getElementById('day-remaining-label').textContent = '剩余 ' + Math.floor(left / 3600) + ' 时 ' + pad(Math.floor(left / 60) % 60) + ' 分';
    const bar = document.getElementById('day-progress');
    const progress = 100 - percent;
    bar.setAttribute('aria-valuenow', progress.toFixed(2));
    bar.setAttribute('aria-valuetext', '今天还剩 ' + document.getElementById('midnight-countdown').textContent);
    bar.style.setProperty('--progress', progress + '%');
    bar.classList.toggle('is-running', remaining > 0);
    bar.classList.toggle('is-urgent', remaining <= 6 * 3600000);
    document.getElementById('day-fill').style.width = progress + '%';
    document.getElementById('day-marker').style.left = 'clamp(10px, ' + progress + '%, calc(100% - 10px))';
    document.getElementById('dial-progress').setAttribute('stroke-dashoffset', String(progress));
    const reset = key !== dialDate;
    if (reset) dial.classList.add('is-resetting');
    // Remaining hours use a 24-hour face; minute and second hands also run backwards.
    hands.forEach((hand, i) => { hand.style.transform = 'rotate(' + remaining / [86400000, 3600000, 60000][i] * 360 + 'deg)'; });
    if (reset) {
      dialDate = key;
      requestAnimationFrame(() => requestAnimationFrame(() => dial.classList.remove('is-resetting')));
    }
    document.getElementById('back-clock-status').textContent = document.getElementById('clock-status').textContent;
  }
  updateDayClock();
  setInterval(updateDayClock, 250);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateDayClock(); });
})();
