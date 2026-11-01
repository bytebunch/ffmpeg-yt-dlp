/* OTW Studio design prototype: routing, controls, theme and language, and simulated job telemetry.
   Everything here is stand-in behaviour for the Next.js build; no request leaves the page. */
(() => {
  'use strict';

  const root = document.documentElement;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode: keep the in-page state only */
      }
    },
  };

  // ------------------------------------------------------------------ language
  const HE = {
    'nav.launch': 'שיגור',
    'nav.jobs': 'משימות',
    'nav.tools': 'כלים',
    'nav.library': 'ספרייה',
    'nav.more': 'עוד',
    'nav.watches': 'מעקבים',
    'nav.search': 'חיפוש',
    'nav.transcripts': 'תמלולים',
    'nav.comments': 'תגובות',
    'nav.settings': 'הגדרות',
    'nav.signout': 'התנתקות',
    sample: 'נתוני דוגמה',
    'role.admin': 'מנהל',
    'launch.greeting': 'ברוך שובך, טאהיר',
    'launch.verb': 'שיגור',
    'launch.quality': 'איכות',
    'launch.more': 'אפשרויות נוספות',
    'deliver.link': 'קישור להורדה',
    'launch.keep': 'קבצים נשמרים 7 ימים.',
    'launch.recent': 'אחרונים',
    'launch.alljobs': 'כל המשימות',
    'launch.inflight': 'בתהליך',
    'status.ready': 'מוכן',
    'status.failed': 'נכשל',
    'composer.label': 'קישור לבדיקה',
    'composer.placeholder': 'הדביקו קישור',
    'composer.paste': 'הדבקה',
    'composer.hint': 'סרטון, פלייליסט, ערוץ או שידור חי. כמה קישורים יחד יוצרים אצווה.',
    'stage.queued': 'בתור',
    'stage.fetch': 'הורדה',
    'stage.process': 'עיבוד',
    'stage.ready': 'מוכן',
    'launch.on': 'רץ על',
    'more.theme': 'בהיר או כהה',
    'servers.title': 'שרתים',
    'servers.hint': 'משימות חדשות נשלחות לשרת שבחרתם.',
    'servers.default': 'ברירת מחדל',
    'servers.rejected': 'לא זמין: מנהל צריך להחליף את המפתח',
    'servers.manage': 'ניהול שרתים',
  };
  const EN = {
    'stage.queued': 'Queued',
    'stage.fetch': 'Fetch',
    'stage.process': 'Process',
    'stage.ready': 'Ready',
    'launch.verb': 'Launch',
  };
  const t = (key) => (root.lang === 'he' && HE[key]) || EN[key] || key;

  // Titles and names come from other sites: isolate them so Hebrew around them can't reorder their
  // punctuation. Runs at load and on every node inserted later (the Next.js build: a <Bdi> component).
  function isolateTitles(scope) {
    $$('.job-title, .row-title, .file-name, .payload-title', scope).forEach((node) => {
      if (node.children.length) return;
      const bdi = document.createElement('bdi');
      bdi.textContent = node.textContent;
      node.replaceChildren(bdi);
    });
  }

  // ------------------------------------------------------------------ the member's server
  // In Next.js the choice lives on the member's profile and the list comes from Studio's database;
  // keys never reach the page. Here the picker's own buttons are the list.
  let server = { key: 'hel', name: 'Helsinki', host: 'ffmpeg.otw.design' };
  function applyServer(item) {
    server = { key: item.dataset.server, name: item.dataset.name, host: item.dataset.host };
    $$('#server-picker .picker-item').forEach((other) =>
      other.setAttribute('aria-checked', String(other === item)),
    );
    $$('[data-server-name]').forEach((node) => {
      node.textContent = server.name;
    });
    $$('[data-server-host]').forEach((node) => {
      node.textContent = server.host;
    });
    $$('[data-action="servers"][aria-label]').forEach((node) =>
      node.setAttribute('aria-label', `Server: ${server.name}. Change server`),
    );
    store.set('studio.server', server.key);
    renderLaunchState();
  }

  // ------------------------------------------------------------------ launch state shared by the band, the bar and the nav
  let inFlight = 3;
  function renderLaunchState() {
    const chip = $('[data-quality] [aria-pressed="true"]');
    const label = chip?.dataset.label || '720p MP4';
    $$('[data-launch-label]').forEach((node) => {
      node.textContent = `${t('launch.verb')} · ${label}`;
    });
    $$('[data-launch-choice]').forEach((node) => {
      node.textContent = `${label} · ${chip?.dataset.size || ''} · ${server.name}`;
    });
    $('#launch-summary').textContent =
      root.lang === 'he'
        ? `${inFlight} משימות בתהליך · 4 קבצים מוכנים להורדה`
        : `${inFlight} jobs in flight · 4 files ready to download`;
    $('#flight-count').textContent = String(inFlight);
    $$('.side-nav .badge').forEach((node) => {
      node.textContent = String(inFlight);
    });
  }

  function applyLanguage(lang) {
    root.lang = lang;
    root.dir = lang === 'he' ? 'rtl' : 'ltr';
    $$('[data-i18n]').forEach((node) => {
      if (!node.dataset.en) node.dataset.en = node.textContent;
      node.textContent = lang === 'he' ? HE[node.dataset.i18n] || node.dataset.en : node.dataset.en;
    });
    $$('[data-i18n-placeholder]').forEach((node) => {
      if (!node.dataset.enPlaceholder) node.dataset.enPlaceholder = node.placeholder;
      node.placeholder =
        lang === 'he' ? HE[node.dataset.i18nPlaceholder] : node.dataset.enPlaceholder;
    });
    $$('[data-action="lang"]').forEach((button) =>
      button.setAttribute('aria-label', lang === 'he' ? 'Switch to English' : 'Switch to Hebrew'),
    );
    $$('#lang-seg button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.langValue === lang)),
    );
    renderLaunchState();
    store.set('studio.lang', lang);
  }

  // ------------------------------------------------------------------ theme
  function applyTheme(theme) {
    root.dataset.theme = theme;
    $('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'light' ? '#f2f1f5' : '#0a0a0d',
    );
    $$('[data-action="theme"]').forEach((button) => {
      button.setAttribute(
        'aria-label',
        theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
      );
      button.querySelector('use')?.setAttribute('href', theme === 'light' ? '#i-moon' : '#i-sun');
    });
    $$('#theme-seg button').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.themeValue === theme)),
    );
    store.set('studio.theme', theme);
  }

  // ------------------------------------------------------------------ routing
  const screens = $$('[data-screen]');
  const titles = {
    launch: 'Launch',
    jobs: 'Jobs',
    job: 'Blender Open Movies',
    tools: 'Tools',
    library: 'Library',
    watches: 'Watches',
    search: 'Search',
    transcripts: 'Transcripts',
    comments: 'Comments',
    settings: 'Settings',
  };
  const navOwner = { job: 'jobs' };
  const inMore = ['watches', 'search', 'transcripts', 'comments', 'settings'];
  let pendingTab = null;

  function route() {
    const name = location.hash.slice(1) || 'launch';
    const screen = screens.find((node) => node.dataset.screen === name) || screens[0];
    const current = screen.dataset.screen;
    screens.forEach((node) => node.classList.toggle('is-active', node === screen));
    const owner = navOwner[current] || current;
    $$('[data-nav]').forEach((link) => {
      const active =
        link.dataset.nav === owner || (link.dataset.nav === 'more' && inMore.includes(owner));
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = `${titles[current]} · OTW Studio`;
    if (pendingTab) {
      selectTab($(`[aria-controls="${pendingTab}"]`));
      pendingTab = null;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ------------------------------------------------------------------ tabs
  function selectTab(tab) {
    if (!tab) return;
    const list = tab.closest('[role="tablist"]');
    $$('[role="tab"]', list).forEach((other) => {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    });
  }

  // ------------------------------------------------------------------ pressed groups and filters
  function press(button) {
    const group = button.closest('[data-single]');
    if (group) {
      $$('[aria-pressed]', group).forEach((other) =>
        other.setAttribute('aria-pressed', String(other === button)),
      );
      if (group.dataset.filter === 'jobs') {
        jobFilter.status = button.dataset.value;
        filterJobs();
      }
      if (group.dataset.filter === 'job-servers') {
        jobFilter.server = button.dataset.value;
        filterJobs();
      }
      if (group.dataset.filter === 'file-servers') {
        $$('.grid-files .file').forEach((file) => {
          file.hidden =
            button.dataset.value !== 'all' && file.dataset.server !== button.dataset.value;
        });
      }
      if (group.dataset.filter === 'recipes') filterRecipes(button.dataset.value);
      if (group.hasAttribute('data-quality')) renderLaunchState();
    } else {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    }
  }

  // status and server filters combine
  const jobFilter = { status: 'all', server: 'all' };
  function filterJobs() {
    let shown = 0;
    $$('#job-groups [data-group-list]').forEach((list) => {
      let inList = 0;
      $$('[data-status]', list).forEach((row) => {
        const match =
          (jobFilter.status === 'all' || row.dataset.status === jobFilter.status) &&
          (jobFilter.server === 'all' || row.dataset.server === jobFilter.server);
        row.hidden = !match;
        if (match) inList += 1;
      });
      list.hidden = inList === 0;
      list.previousElementSibling.hidden = inList === 0;
      shown += inList;
    });
    $('#jobs-empty').hidden = shown > 0;
  }

  function filterRecipes(kind) {
    let first = null;
    $$('#recipes .recipe').forEach((recipe) => {
      recipe.hidden = recipe.dataset.kind !== kind;
      if (!recipe.hidden && !first) first = recipe;
    });
    if (first && !$('#recipes .recipe[aria-pressed="true"]:not([hidden])')) press(first);
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = 0;
  function toast(message) {
    const node = $('#toast');
    node.querySelector('span').textContent = message;
    node.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
  }

  // ------------------------------------------------------------------ telemetry
  const PHASES = [
    { key: 'stage.queued', from: 0, to: 4, ms: 900 },
    { key: 'stage.fetch', from: 4, to: 82, ms: 4400, speed: true },
    { key: 'stage.process', from: 82, to: 99, ms: 1700 },
  ];

  function setTrack(track, phaseIndex, phasePercent) {
    $$('i', track).forEach((segment, index) => {
      segment.classList.toggle('done', index < phaseIndex);
      segment.classList.toggle('now', index === phaseIndex);
      segment.style.setProperty('--p', index === phaseIndex ? `${phasePercent}%` : '0%');
    });
  }

  function runFlight(card) {
    const track = $('.track', card);
    const pct = $('[data-pct]', card);
    const stage = $('[data-stage]', card);
    const speed = $('[data-speed]', card);
    const eta = $('[data-eta]', card);
    let phaseIndex = 0;
    let started = performance.now();

    const tick = (now) => {
      const phase = PHASES[phaseIndex];
      const progress = Math.min(1, (now - started) / phase.ms);
      const overall = Math.round(phase.from + (phase.to - phase.from) * progress);
      setTrack(track, phaseIndex, Math.round(progress * 100));
      pct.textContent = `${overall}%`;
      stage.textContent = t(phase.key);
      speed.textContent = phase.speed ? `${(5.4 + Math.sin(now / 400)).toFixed(1)} MB/s` : '';
      eta.textContent = phase.speed ? `${Math.max(1, Math.round((1 - progress) * 52))} s left` : '';
      if (progress < 1) return requestAnimationFrame(tick);
      phaseIndex += 1;
      started = now;
      if (phaseIndex < PHASES.length) return requestAnimationFrame(tick);
      setTrack(track, 4, 0);
      pct.textContent = '312 MB';
      stage.textContent = t('stage.ready');
      speed.textContent = '';
      eta.textContent = '';
      card
        .querySelector('.job-meta')
        .insertAdjacentHTML('beforeend', '<span class="pill pill-ok">Ready</span>');
      toast('Sintel is ready to download');
      return undefined;
    };
    requestAnimationFrame(tick);
  }

  function launch(button) {
    button.classList.add('is-loading');
    setTimeout(() => {
      button.classList.remove('is-loading');
      const card = $('#flight-template').content.firstElementChild.cloneNode(true);
      const label = $('[data-quality] [aria-pressed="true"]')?.dataset.label || '720p MP4';
      $('[data-choice]', card).textContent = label;
      $('[data-server-name]', card).textContent = server.name;
      isolateTitles(card);
      $('#flights').prepend(card);
      inFlight += 1;
      renderLaunchState();
      card.scrollIntoView({
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'start',
      });
      toast(`Launched on ${server.name}: Sintel, ${label}`);
      runFlight(card);
    }, 450);
  }

  // jobs already in flight creep forward so the page reads as live
  function tickLive() {
    $$('.track[data-live]').forEach((track) => {
      const value = Math.min(99, Number(track.dataset.live) + 0.4);
      track.dataset.live = String(value);
      const now = $('i.now', track);
      if (now) now.style.setProperty('--p', `${value}%`);
      const pct = track.parentElement.querySelector('[data-pct]');
      if (pct) pct.textContent = `${Math.floor(value)}%`;
    });
    $$('[data-clock]').forEach((clock) => {
      const [h, m, s] = clock.textContent.split(':').map(Number);
      const total = h * 3600 + m * 60 + s + 2;
      clock.textContent = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
    });
  }

  // ------------------------------------------------------------------ uploads
  function addUpload(file) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="thumb thumb-file" style="width:64px;border-radius:8px"><svg class="icon"><use href="#i-file"/></svg></div>
      <div class="row-main"><div class="row-title"></div><div class="row-sub num">Starting…</div>
        <div class="track" style="margin-block-start:8px;grid-template-columns:1fr"><i class="now" style="--p:0%"></i></div></div>`;
    row.querySelector('.row-title').textContent = file.name;
    isolateTitles(row);
    $('#uploads').prepend(row);
    const mb = Math.max(1, file.size / 1048576);
    let done = 0;
    const timer = setInterval(() => {
      done = Math.min(mb, done + Math.max(0.5, mb / 12));
      const percent = Math.round((done / mb) * 100);
      row.querySelector('.track i').style.setProperty('--p', `${percent}%`);
      row.querySelector('.row-sub').textContent =
        percent < 100
          ? `${done.toFixed(1)} of ${mb.toFixed(1)} MB`
          : `Uploaded · ${mb.toFixed(1)} MB`;
      if (percent >= 100) clearInterval(timer);
    }, 300);
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, a');
    if (!target) return;

    if (target.matches('[role="tab"]')) {
      selectTab(target);
      return;
    }
    if (target.matches('.picker-item')) {
      if (target.getAttribute('aria-disabled') === 'true') {
        toast(`${target.dataset.name} can't take jobs until an admin replaces its key`);
        return;
      }
      applyServer(target);
      $('#server-picker').close();
      toast(`New jobs go to ${server.name}`);
      return;
    }
    if (target.dataset.tabTarget) {
      pendingTab = target.dataset.tabTarget;
      if (location.hash === target.getAttribute('href')) {
        selectTab($(`[aria-controls="${pendingTab}"]`));
        pendingTab = null;
      }
    }
    if (target.matches('[aria-pressed]') && !target.dataset.themeValue && !target.dataset.langValue)
      press(target);
    if (target.dataset.themeValue) applyTheme(target.dataset.themeValue);
    if (target.dataset.langValue) applyLanguage(target.dataset.langValue);
    if (target.matches('a') && target.closest('dialog')) target.closest('dialog').close();

    switch (target.dataset.action) {
      case 'theme':
        applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light');
        break;
      case 'lang':
        applyLanguage(root.lang === 'he' ? 'en' : 'he');
        break;
      case 'more':
        $('#more-sheet').showModal();
        break;
      case 'launch':
        launch(target);
        break;
      case 'toast':
        toast(target.dataset.message);
        break;
      case 'dismiss':
        $(`#${target.dataset.target}`).hidden = true;
        break;
      case 'new-link':
        $('#composer').dataset.state = 'link';
        $('#composer-input').value = '';
        $('#composer-input').focus();
        break;
      case 'clear':
        $('#composer-input').value = '';
        $('#composer-input').focus();
        break;
      case 'preview-storage':
        $('#storage-alert').hidden = false;
        break;
      case 'preview-empty':
        jobFilter.status = 'none';
        filterJobs();
        $$('[data-filter="jobs"] [aria-pressed]').forEach((b) =>
          b.setAttribute('aria-pressed', 'false'),
        );
        break;
      case 'servers':
        $('#server-picker').showModal();
        break;
      case 'test-server':
        testServer();
        break;
      case 'test-state':
        event.preventDefault();
        showTest(target.dataset.state, $('#sv-url').value || 'https://media.example.com');
        break;
      case 'reveal': {
        const node = $(`#${target.dataset.target}`);
        node.hidden = !node.hidden;
        if (!node.hidden) $('input', node)?.focus();
        break;
      }
      case 'paste':
        navigator.clipboard
          ?.readText()
          .then((text) => {
            $('#composer-input').value = text.trim();
            $('#composer-input').focus();
          })
          .catch(() => toast('Allow clipboard access, or paste with your keyboard'));
        break;
      default:
    }
  });

  // sheets close when their backdrop is tapped
  $$('dialog.sheet').forEach((dialog) =>
    dialog.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) dialog.close();
    }),
  );

  // ------------------------------------------------------------------ add a server (Settings → Servers)
  // Next.js runs the real test on its server: a call to the API with the key, HTTPS only, public
  // addresses only. Save stays locked until a test passes.
  const TESTS = {
    testing: ['i-retry', (host) => `Testing ${host}…`, 'Calling the API with this key.'],
    ok: ['i-check', () => 'Online', (host) => `The key works. ${host} answered in 0.2 s.`],
    key: [
      'i-alert',
      () => 'Key rejected',
      () =>
        'The server answered 401. Check you copied the whole key, or create a new one on the server.',
    ],
    down: [
      'i-alert',
      (host) => `Can't reach ${host}`,
      () =>
        'No answer within 10 s. Check the address, its DNS, and that the service is running with HTTPS.',
    ],
    http: [
      'i-alert',
      () => 'Not HTTPS',
      () => 'The key travels with every request, so Studio only connects to https:// addresses.',
    ],
    private: [
      'i-alert',
      () => 'Private address',
      (host) => `${host} points into a private network. Studio only connects to public servers.`,
    ],
    empty: ['i-alert', () => 'Address and key needed', () => 'Fill in both before testing.'],
  };
  function showTest(kind, url) {
    const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [icon, title, text] = TESTS[kind];
    const box = $('#test-result');
    box.hidden = false;
    box.dataset.state = kind === 'ok' || kind === 'testing' ? kind : 'fail';
    box.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg><b></b><p></p>`;
    $('b', box).textContent = title(host);
    $('p', box).textContent = typeof text === 'function' ? text(host) : text;
    $('#save-server').disabled = kind !== 'ok';
  }
  function testServer() {
    const url = $('#sv-url').value.trim();
    if (!url || !$('#sv-key').value) {
      showTest('empty', url);
      return;
    }
    if (!url.startsWith('https://')) {
      showTest('http', url);
      return;
    }
    showTest('testing', url);
    setTimeout(() => showTest('ok', url), 900);
  }
  $('#add-server-form').addEventListener('input', () => {
    $('#save-server').disabled = true;
  });
  $('#add-server-form').addEventListener('submit', (event) => {
    event.preventDefault();
    toast(`${$('#sv-name').value || 'Server'} saved. Members can pick it now.`);
    event.target.reset();
    $('#test-result').hidden = true;
    $('#save-server').disabled = true;
  });

  // arrow keys move between tabs
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
    const forward = ['ArrowDown', root.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'].includes(
      event.key,
    );
    const next = tabs[(tabs.indexOf(tab) + (forward ? 1 : -1) + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
    event.preventDefault();
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#composer-input');
    if (!input.value.trim()) {
      input.focus();
      toast('Paste a link first');
      return;
    }
    $('#composer').dataset.state = 'ready';
    $('#payload').scrollIntoView({
      behavior: reducedMotion.matches ? 'auto' : 'smooth',
      block: 'start',
    });
    toast('Looked up in 1.4 s');
  });

  const dropzone = $('#dropzone');
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, () => dropzone.classList.remove('is-over')),
  );
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    [...event.dataTransfer.files].forEach(addUpload);
  });
  $('#file-input').addEventListener('change', (event) => {
    [...event.target.files].forEach(addUpload);
    event.target.value = '';
  });

  // ------------------------------------------------------------------ start
  isolateTitles(document);
  const savedServer = $(
    `#server-picker .picker-item[data-server="${store.get('studio.server')}"]:not([aria-disabled="true"])`,
  );
  if (savedServer) applyServer(savedServer);
  applyTheme(store.get('studio.theme') || 'dark');
  applyLanguage(store.get('studio.lang') || 'en');
  window.addEventListener('hashchange', route);
  route();
  setInterval(tickLive, 2000);
})();
