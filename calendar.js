(function () {
  'use strict';

  const api = window.KaoyanExtras;
  const dialog = document.getElementById('calendar-dialog');
  if (!api || !dialog) return;

  const DAY = 86400000;
  const MIN_YEAR = 2026;
  const MAX_YEAR = 2026;
  const MIN_DATE = '2026-01-01';
  const MAX_DATE = '2026-12-31';
  const DATA_YEAR = 2026;
  const CURRENT_START = '2026-09-29';
  const EXAMS = ['2026-12-19', '2026-12-20'];
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const WEEK_HEADER = ['一', '二', '三', '四', '五', '六', '日'];
  const VIEWS = ['year', 'quarter', 'month'];
  const get = id => document.getElementById(id);
  const pad = value => String(value).padStart(2, '0');
  const stage = get('cal-stage');
  const hoverMotion = window.matchMedia('(prefers-reduced-motion:reduce)');
  const hoverStates = new Map();
  const MIN_HOVER_MS = 240;

  function clearDateHovers() {
    for (const [button, state] of hoverStates) {
      clearTimeout(state.timer);
      button.classList.remove('is-hovered');
    }
    hoverStates.clear();
  }

  // Hold a brief pass until the entrance has completed, then fade out.
  // Re-entering cancels only the pending exit, without restarting the entrance.
  function enterDate(button) {
    const state = hoverStates.get(button) || { started:performance.now(), timer:null };
    clearTimeout(state.timer);
    state.timer = null;
    hoverStates.set(button, state);
    button.classList.add('is-hovered');
  }
  function leaveDate(button) {
    const state = hoverStates.get(button);
    if (!state) return;
    const delay = hoverMotion.matches ? 0 : Math.max(0, MIN_HOVER_MS - (performance.now() - state.started));
    const finish = () => {
      button.classList.remove('is-hovered');
      hoverStates.delete(button);
    };
    clearTimeout(state.timer);
    if (delay === 0) finish();
    else state.timer = setTimeout(finish, delay);
  }
  for (const type of ['pointerover', 'pointerout']) {
    stage.addEventListener(type, event => {
      if (event.pointerType === 'touch') return;
      const button = event.target.closest('.cal-day');
      if (!button || !stage.contains(button) || button.contains(event.relatedTarget)) return;
      if (type === 'pointerover') enterDate(button);
      else leaveDate(button);
    });
  }
  hoverMotion.addEventListener('change', clearDateHovers);
  const sourceStates = new Map([
    [api.LEGACY_DATA_URL, { status: 'idle', records: new Map(), version: 0 }],
    [api.DATA_URL, { status: 'idle', records: new Map(), version: 0 }]
  ]);

  // Use UTC date arithmetic for calendar days. Clock dates come from the original
  // Beijing-time helper, so device timezones and daylight saving cannot shift cells.
  function dateParts(key) {
    const [year, month, day] = key.split('-').map(Number);
    return { year, month: month - 1, day };
  }
  function keyFor(year, month, day) {
    const date = new Date(Date.UTC(year, month, day));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  function dayNumber(key) {
    const { year, month, day } = dateParts(key);
    return Date.UTC(year, month, day) / DAY;
  }
  function shiftDate(key, days) {
    const { year, month, day } = dateParts(key);
    return keyFor(year, month, day + days);
  }
  function weekday(key) {
    return new Date(dayNumber(key) * DAY).getUTCDay();
  }
  function distance(target, from) {
    return dayNumber(target) - dayNumber(from);
  }
  function relativeDays(value) {
    return value > 0 ? `距今天 ${value} 天` : value < 0 ? `已过 ${-value} 天` : '就是今天';
  }
  function spokenDistance(target, from, label) {
    const value = distance(target, from);
    return value > 0 ? `距${label} ${value} 天` : value < 0 ? `${label}已过 ${-value} 天` : `${label}当天`;
  }
  function todayKey() {
    return api.dateKey(new Date(api.now()));
  }
  function sourceFor(key) {
    if (!key.startsWith(DATA_YEAR + '-')) return null;
    return sourceStates.get(key < CURRENT_START ? api.LEGACY_DATA_URL : api.DATA_URL);
  }
  function quoteFor(key) {
    return sourceFor(key)?.records.get(key);
  }
  function readableQuote(key) {
    return key <= today && quoteFor(key);
  }
  function periodClasses(key) {
    const names = [];
    if (key > EXAMS[1]) names.push('is-outside');
    else if (key < today) names.push('is-past');
    if (key === today) names.push('is-today');
    if (EXAMS.includes(key)) names.push('is-exam');
    const start = today < '2026-01-01' ? '2026-01-01' : today;
    if (key >= start && key <= EXAMS[1]) {
      names.push('is-range');
      if (key === start) names.push('range-start');
      if (key === EXAMS[1]) names.push('range-end');
      if (weekday(key) === 1 || key.endsWith('-01')) names.push('range-row-start');
      if (weekday(key) === 0 || dateParts(shiftDate(key, 1)).day === 1) names.push('range-row-end');
    }
    return names;
  }
  function withinYears(key) {
    return key >= MIN_DATE && key <= MAX_DATE;
  }
  function clampDate(key) {
    return key < MIN_DATE ? MIN_DATE : key > MAX_DATE ? MAX_DATE : key;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let today = todayKey();
  let selected = clampDate(today);
  const initial = dateParts(selected);
  let anchor = { year: DATA_YEAR, month: initial.month };
  let view = 'month';
  let opener = null;
  let currentQuote = '';
  let copyVersion = 0;

  function setAnchor(key) {
    const parts = dateParts(clampDate(key));
    anchor = { year: DATA_YEAR, month: parts.month };
  }

  function dayClasses(key) {
    const names = ['cal-day', ...periodClasses(key)];
    if (key === selected) names.push('is-selected');
    if (readableQuote(key)) names.push('has-quote');
    return names.join(' ');
  }

  function dayButton(year, month, day) {
    const key = keyFor(year, month, day);
    const button = element('button', dayClasses(key));
    button.type = 'button';
    button.dataset.date = key;
    button.setAttribute('aria-pressed', String(key === selected));
    if (key === today) button.setAttribute('aria-current', 'date');
    const markers = [];
    if (key === today) markers.push('今天');
    if (key > EXAMS[1]) markers.push('考试之后');
    else if (key < today) markers.push('已过日期');
    if (key === EXAMS[0]) markers.push('初试第一天');
    if (key === EXAMS[1]) markers.push('初试第二天');
    if (readableQuote(key)) markers.push('可读每日一句');
    const label = `${year}年${month + 1}月${day}日，${WEEKDAYS[weekday(key)]}，` +
      [...markers, spokenDistance(EXAMS[0], key, '初试第一天'), spokenDistance(EXAMS[1], key, '初试第二天')].join('，');
    button.setAttribute('aria-label', label);
    button.append(element('span', '', String(day)));
    let caption = '';
    if (key === EXAMS[0]) caption = key === today ? '今日 · 初试一' : '初试一';
    else if (key === EXAMS[1]) caption = key === today ? '今日 · 初试二' : '初试二';
    else if (key === today) caption = '今日';
    else if (key < today && key <= EXAMS[1]) caption = '已过';
    if (caption) button.append(element('small', '', caption));
    return button;
  }

  function monthSection(year, month) {
    const section = element('section', 'cal-month');
    section.setAttribute('aria-label', `${year}年${month + 1}月`);
    section.append(element('h3', '', `${month + 1} 月`));
    const weekdays = element('div', 'weekday-row');
    weekdays.setAttribute('aria-hidden', 'true');
    WEEK_HEADER.forEach(name => weekdays.append(element('span', '', name)));
    section.append(weekdays);
    const grid = element('div', 'day-grid');
    const offset = (weekday(keyFor(year, month, 1)) + 6) % 7;
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let i = 0; i < offset; i++) {
      const blank = element('span');
      blank.setAttribute('aria-hidden', 'true');
      placeCell(blank, i);
      grid.append(blank);
    }
    for (let day = 1; day <= count; day++) {
      const button = dayButton(year, month, day);
      placeCell(button, offset + day - 1);
      grid.append(button);
    }
    addRangeBands(grid, year, month, offset);
    section.append(grid);
    return section;
  }

  function monthPreview(year, month) {
    const button = element('button', 'cal-month-preview');
    button.type = 'button';
    button.dataset.month = String(month);
    button.setAttribute('aria-label', `${year}年${month + 1}月，点击放大到月视图` +
      (year === DATA_YEAR && month === 11 ? '，19日初试第一天，20日初试第二天' : ''));
    button.append(element('h3', '', `${month + 1} 月`));
    const mini = element('div', 'mini-grid');
    mini.setAttribute('aria-hidden', 'true');
    WEEK_HEADER.forEach((name, index) => {
      const label = element('span', 'mini-weekday', name);
      placeCell(label, index);
      mini.append(label);
    });
    const offset = (weekday(keyFor(year, month, 1)) + 6) % 7;
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let i = 0; i < offset; i++) {
      const blank = element('span');
      placeCell(blank, i, 2);
      mini.append(blank);
    }
    for (let day = 1; day <= count; day++) {
      const key = keyFor(year, month, day);
      const classes = periodClasses(key);
      if (key === selected) classes.push('is-selected');
      const cell = element('span', classes.join(' '), String(day));
      cell.dataset.day = key;
      placeCell(cell, offset + day - 1, 2);
      mini.append(cell);
    }
    // Equal six-week previews keep the year view easy to scan and aligned.
    while (mini.childElementCount < 49) {
      const blank = element('span');
      placeCell(blank, mini.childElementCount);
      mini.append(blank);
    }
    addRangeBands(mini, year, month, offset, 2);
    button.append(mini);
    button.append(element('p', '', year === DATA_YEAR && month === 11 ? '19 · 20 日初试' : '\u00a0'));
    return button;
  }

  function placeCell(cell, index, firstRow = 1) {
    cell.style.gridColumn = String(index % 7 + 1);
    cell.style.gridRow = String(Math.floor(index / 7) + firstRow);
  }
  function addRangeBands(grid, year, month, offset, firstRow = 1) {
    const rows = new Map();
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= count; day++) {
      if (!periodClasses(keyFor(year, month, day)).includes('is-range')) continue;
      const index = offset + day - 1;
      const row = Math.floor(index / 7) + firstRow;
      const column = index % 7 + 1;
      const segment = rows.get(row);
      if (segment) segment.end = column;
      else rows.set(row, { start:column, end:column });
    }
    for (const [row, segment] of rows) {
      const band = element('span', 'range-band');
      band.setAttribute('aria-hidden', 'true');
      band.style.gridRow = String(row);
      band.style.gridColumn = segment.start + ' / ' + (segment.end + 1);
      grid.append(band);
    }
  }

  function renderCalendar() {
    clearDateHovers();
    const activeDate = stage.contains(document.activeElement) ? document.activeElement.dataset.date : null;
    const activeMonth = stage.contains(document.activeElement) ? document.activeElement.dataset.month : null;
    const grid = element('div', `cal-${view}-grid`);
    if (view === 'year') {
      for (let month = 0; month < 12; month++) grid.append(monthPreview(anchor.year, month));
      get('cal-period').textContent = `${anchor.year} 年`;
    } else if (view === 'quarter') {
      const first = Math.floor(anchor.month / 3) * 3;
      for (let month = first; month < first + 3; month++) grid.append(monthSection(anchor.year, month));
      get('cal-period').textContent = `${anchor.year} 年 · 第 ${Math.floor(first / 3) + 1} 季度`;
    } else {
      grid.append(monthSection(anchor.year, anchor.month));
      get('cal-period').textContent = `${anchor.year} 年 ${anchor.month + 1} 月`;
    }
    stage.replaceChildren(grid);
    // A late data response or a Beijing midnight refresh should preserve keyboard
    // focus while adding quote markers and updating the current-day appearance.
    if (activeDate) stage.querySelector(`[data-date="${activeDate}"]`)?.focus({ preventScroll: true });
    else if (activeMonth !== undefined && activeMonth !== null) stage.querySelector(`[data-month="${activeMonth}"]`)?.focus({ preventScroll: true });
    document.querySelectorAll('[data-calendar-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.calendarView === view));
    });
    const index = VIEWS.indexOf(view);
    get('zoom-out').disabled = index === 0;
    get('zoom-in').disabled = index === VIEWS.length - 1;
    get('cal-zoom-label').textContent = ['年视图 · 点击月份放大', '季视图 · 点击日期读一句', '月视图 · 点击日期读一句'][index];
    const atStart = anchor.year === MIN_YEAR && (view === 'year' || (view === 'quarter' ? anchor.month < 3 : anchor.month === 0));
    const atEnd = anchor.year === MAX_YEAR && (view === 'year' || (view === 'quarter' ? anchor.month >= 9 : anchor.month === 11));
    get('cal-prev').disabled = atStart;
    get('cal-next').disabled = atEnd;
    get('cal-today').disabled = !withinYears(today);
    get('cal-today').title = withinYears(today) ? '' : '日历仅显示 2026 年，今天不在此范围内。';
    const period = { year: '年', quarter: '季度', month: '月' }[view];
    get('cal-prev').setAttribute('aria-label', '上一' + period);
    get('cal-next').setAttribute('aria-label', '下一' + period);
  }

  function renderQuote() {
    copyVersion++;
    currentQuote = '';
    const { year, month, day } = dateParts(selected);
    const selectedDate = get('selected-date');
    selectedDate.dateTime = selected;
    selectedDate.textContent = `${year}.${pad(month + 1)}.${pad(day)}`;
    get('selected-weekday').textContent = WEEKDAYS[weekday(selected)] + (selected > EXAMS[1] ? ' · 考试之后' : selected === today ? ' · 今天' : selected > today ? ' · 未来的日子' : ' · 走过的日子');
    get('selected-distance').replaceChildren(
      element('p', '', spokenDistance(EXAMS[0], selected, '初试第一天')),
      element('p', '', spokenDistance(EXAMS[1], selected, '初试第二天'))
    );
    get('quote-prev').disabled = !withinYears(shiftDate(selected, -1));
    get('quote-next').disabled = !withinYears(shiftDate(selected, 1));
    get('quote-status').textContent = '';
    const source = sourceFor(selected);
    const entry = quoteFor(selected);
    get('quote-retry').hidden = selected > today || source?.status !== 'error';
    get('quote-today').hidden = selected === today || !withinYears(today);
    const quote = get('selected-quote');
    const meta = get('selected-meta');
    if (selected > today) {
      quote.textContent = selected <= EXAMS[1] ? '这一天的鼓励，留到当天再读。' : '备考日历在 12 月 20 日落下句点。';
      meta.textContent = selected <= EXAMS[1] ? '先把今天走稳，每日一句会在北京时间零点更新。' : '把注意力留给今天，让未来的日子先留白。';
    } else if (!source) {
      quote.textContent = '这一年的每日一句还未收录。愿你在这一天，也能稳稳向前。';
      meta.textContent = '目前收录 2026 年的每日一句。试试「定位考试」或切换回 2026 年。';
    } else if (source.status === 'loading' || source.status === 'idle') {
      quote.textContent = '正在翻开这一天的句子…';
      meta.textContent = '稍候片刻，这一天的鼓励马上就来。';
    } else if (source.status === 'error') {
      quote.textContent = '这一天的句子暂时没能加载。';
      meta.textContent = '点击「重新加载」再试一次。';
    } else if (!entry) {
      quote.textContent = '这一天还没有收录每日一句。愿日子缓缓，努力有光。';
      meta.textContent = '已收录 2026 年 1 月 1 日至 12 月 20 日的每日一句。';
    } else {
      try {
        currentQuote = api.entryText(entry);
        quote.textContent = currentQuote;
        meta.textContent = selected === today ? '今日一句 · 把今天走稳。' : '每日一句 · 每一天，都值得回看。';
      } catch (_) {
        quote.textContent = '这一天的句子暂时无法解码。';
        meta.textContent = '日期与距离仍可查看，请试试相邻的日子。';
      }
    }
    get('quote-copy').disabled = !currentQuote;
  }

  function updateExamDistances() {
    EXAMS.forEach((key, index) => {
      get(index ? 'exam-second-distance' : 'exam-first-distance').textContent = relativeDays(distance(key, today));
    });
    const now = api.now();
    const start = Date.parse('2026-01-01T00:00:00+08:00');
    const target = Date.parse(EXAMS[0] + 'T08:30:00+08:00');
    const remaining = Math.max(0, target - now);
    const remainingPercent = Math.max(0, Math.min(100, remaining / (target - start) * 100));
    const progress = 100 - remainingPercent;
    const bar = get('journey-progress');
    bar.setAttribute('aria-valuenow', progress.toFixed(2));
    bar.setAttribute('aria-valuetext', '时间示意，不代表个人备考进度。' + relativeDays(distance(EXAMS[0], today)));
    bar.classList.toggle('is-running', remaining > 0);
    bar.classList.toggle('is-urgent', remaining > 0 && remaining <= 30 * DAY);
    bar.style.setProperty('--progress', progress + '%');
    get('journey-fill').style.width = progress + '%';
    get('journey-marker').style.left = 'clamp(10px, ' + progress + '%, calc(100% - 10px))';
    get('journey-label').textContent = '进度条仅作时间示意，不代表个人备考进度。';
  }

  async function loadSource(url, retry) {
    const source = sourceStates.get(url);
    if (source.status === 'ready' || source.status === 'loading' || (!retry && source.status === 'error')) return;
    source.status = 'loading';
    const request = ++source.version;
    renderQuote();
    try {
      const records = await api.loadDataSource(url);
      if (request !== source.version) return;
      source.records = records;
      source.status = 'ready';
    } catch (_) {
      if (request !== source.version) return;
      source.status = 'error';
    }
    renderCalendar();
    renderQuote();
  }

  function ensureData(retry = false) {
    // Each source succeeds independently. The original loader also caches promises,
    // so opening this view does not issue duplicate successful data requests.
    for (const [url] of sourceStates) loadSource(url, retry);
  }

  function selectDate(key, focusDay = false) {
    if (!withinYears(key)) return;
    selected = key;
    setAnchor(key);
    renderCalendar();
    renderQuote();
    if (focusDay) stage.querySelector(`[data-date="${selected}"]`)?.focus({ preventScroll: true });
  }

  function changeView(next) {
    if (!VIEWS.includes(next)) return;
    view = next;
    renderCalendar();
  }

  function movePeriod(direction) {
    if (view === 'year') return;
    const month = view === 'quarter' ? Math.floor(anchor.month / 3) * 3 : anchor.month;
    const key = keyFor(anchor.year, month + direction * (view === 'quarter' ? 3 : 1), 1);
    if (!withinYears(key)) return;
    const next = dateParts(key);
    anchor = { year: DATA_YEAR, month: next.month };
    renderCalendar();
  }

  function refreshDay() {
    const next = todayKey();
    if (next !== today) {
      const followingToday = selected === today;
      today = next;
      if (followingToday) {
        selected = clampDate(today);
        setAnchor(selected);
      }
      renderCalendar();
      renderQuote();
    }
    updateExamDistances();
  }

  function openCalendar(event) {
    opener = event.currentTarget;
    refreshDay();
    renderCalendar();
    renderQuote();
    dialog.showModal();
    get('calendar-title').focus({ preventScroll: true });
    ensureData();
  }

  get('calendar-open').addEventListener('click', openCalendar);
  get('calendar-open-back').addEventListener('click', openCalendar);
  get('calendar-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clearDateHovers();
    opener?.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

  stage.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !stage.contains(button)) return;
    if (button.dataset.date) {
      selectDate(button.dataset.date, true);
      if (event.detail > 0 && window.matchMedia('(max-width:800px)').matches) {
        get('selected-quote').closest('.quote-panel').scrollIntoView({
          block:'nearest', behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth'
        });
      }
    }
    else if (button.dataset.month !== undefined) {
      anchor.month = Number(button.dataset.month);
      changeView('month');
      const selectedParts = dateParts(selected);
      const first = keyFor(anchor.year, anchor.month, 1);
      const focusKey = selectedParts.year === anchor.year && selectedParts.month === anchor.month ? selected : first;
      stage.querySelector(`[data-date="${focusKey}"]`)?.focus({ preventScroll: true });
    }
  });
  stage.addEventListener('keydown', event => {
    const key = event.target.dataset?.date;
    if (!key || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let delta;
    if (event.key === 'ArrowLeft') delta = -1;
    if (event.key === 'ArrowRight') delta = 1;
    if (event.key === 'ArrowUp') delta = -7;
    if (event.key === 'ArrowDown') delta = 7;
    if (event.key === 'Home') delta = -((weekday(key) + 6) % 7);
    if (event.key === 'End') delta = 6 - ((weekday(key) + 6) % 7);
    if (delta === undefined) return;
    event.preventDefault();
    const next = shiftDate(key, delta);
    if (withinYears(next)) selectDate(next, true);
  });
  document.querySelectorAll('[data-calendar-view]').forEach(button => {
    button.addEventListener('click', () => changeView(button.dataset.calendarView));
  });
  get('zoom-out').addEventListener('click', () => changeView(VIEWS[Math.max(0, VIEWS.indexOf(view) - 1)]));
  get('zoom-in').addEventListener('click', () => changeView(VIEWS[Math.min(2, VIEWS.indexOf(view) + 1)]));
  get('cal-prev').addEventListener('click', () => movePeriod(-1));
  get('cal-next').addEventListener('click', () => movePeriod(1));
  get('cal-today').addEventListener('click', () => { refreshDay(); selectDate(today); });
  get('cal-exam').addEventListener('click', () => selectDate(EXAMS[0]));
  get('quote-prev').addEventListener('click', () => selectDate(shiftDate(selected, -1)));
  get('quote-next').addEventListener('click', () => selectDate(shiftDate(selected, 1)));
  get('quote-today').addEventListener('click', () => { refreshDay(); selectDate(today); });
  get('quote-retry').addEventListener('click', () => ensureData(true));
  get('quote-copy').addEventListener('click', async () => {
    if (!currentQuote) return;
    const request = ++copyVersion;
    const text = `${selected}\n${currentQuote}`;
    try {
      await navigator.clipboard.writeText(text);
      if (request === copyVersion) get('quote-status').textContent = '已复制日期与这一天的句子。';
    } catch (_) {
      if (request === copyVersion) get('quote-status').textContent = '暂时无法自动复制，可以长按或选中上方句子手动复制。';
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDay(); });
  setInterval(refreshDay, 1000);
  renderCalendar();
  renderQuote();
  updateExamDistances();
})();
