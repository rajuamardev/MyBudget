/* MyBudget – UI layer. All business rules live in logic.js. */
(function () {
  'use strict';

  const L = window.MyBudgetLogic;
  if (!L || typeof L.typeLabel !== 'function' || typeof L.formatDay !== 'function' || typeof L.diffState !== 'function' || typeof L.totalSummary !== 'function') {
    document.getElementById('view').innerHTML = '<div class="banner"><span>logic.js tidak ditemukan atau versinya lama. Pastikan index.html, styles.css, logic.js, dan app.js semuanya versi terbaru dan berada di satu folder, lalu muat ulang halaman.</span></div>';
    return;
  }
  const LEGACY_KEY = 'mybudget:v1';     // old browser-only storage, read once to offer a migration
  const CONFIG_KEY = 'mybudget:config'; // device-local connection settings (Apps Script URL + access code), never data

  let notice = '';
  let state = L.emptyState();   // working copy shown in the UI
  let synced = L.emptyState();  // last copy the spreadsheet confirmed; used to compute changes and to roll back
  let conn = 'loading';         // setup | loading | error | ready
  let connError = '';
  let busy = false;             // a write is in flight
  let lastLoad = 0;
  let formDelete = null;   // delete handler of the form currently open in the dialog
  let flashId = null;      // id of a just-created transaction, highlighted once on the next render
  const ui = { view: 'overview', month: L.currentMonthKey(), txType: 'all', txCategory: 'all' };

  const $view = document.getElementById('view');
  const $dlg = document.getElementById('dialog');
  const $toast = document.getElementById('toast');
  const $nav = document.getElementById('nav');

  const CAL = '<svg class="ic" width="24" height="24" viewBox="0 0 12 12" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="M2 1h2v1h-2zM8 1h2v1h-2zM0 2h12v1h-12zM0 3h12v1h-12zM0 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM2 5h2v1h-2zM5 5h2v1h-2zM8 5h2v1h-2zM11 5h1v1h-1zM0 6h1v1h-1zM2 6h2v1h-2zM5 6h2v1h-2zM8 6h2v1h-2zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM0 8h1v1h-1zM2 8h2v1h-2zM5 8h2v1h-2zM8 8h2v1h-2zM11 8h1v1h-1zM0 9h1v1h-1zM2 9h2v1h-2zM5 9h2v1h-2zM8 9h2v1h-2zM11 9h1v1h-1zM0 10h1v1h-1zM11 10h1v1h-1zM0 11h12v1h-12z"/></svg>';
  const CHECK ='<svg class="ic check" width="16" height="16" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="M6 1h2v1h-2zM5 2h2v1h-2zM0 3h1v1h-1zM4 3h2v1h-2zM0 4h2v1h-2zM3 4h2v1h-2zM1 5h3v1h-3zM2 6h1v1h-1z"/></svg>';

  /* ---------- spreadsheet (Google Apps Script) ---------- */

  const URL_RE = /^(https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+\/|macros\/)s\/[\w-]+\/exec|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*)$/;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function getConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return c && typeof c.url === 'string' && typeof c.token === 'string' && c.url && c.token ? c : null;
    } catch (e) { return null; }
  }
  function setConfig(c) { try { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); return true; } catch (e) { return false; } }

  // One POST per call. text/plain keeps it a "simple" request, so the browser sends no CORS preflight (Apps Script cannot answer one).
  function api(action, payload, cfg) {
    cfg = cfg || getConfig();
    if (!cfg) return Promise.reject({ kind: 'config' });
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 30000);
    return fetch(cfg.url, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: cfg.token, action: action }, payload || {})),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { return res.text(); }).then(function (txt) {
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw { kind: 'format' }; }
      if (!j || j.ok !== true) throw { kind: 'server', code: j && j.error };
      return j;
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.kind) throw e;
      throw { kind: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    }).then(function (j) { clearTimeout(timer); return j; });
  }

  function errorText(err) {
    const k = err && err.kind, code = err && err.code;
    if (k === 'network') return 'Tidak bisa terhubung ke Spreadsheet. Periksa koneksi internet, lalu coba lagi.';
    if (k === 'timeout') return 'Spreadsheet terlalu lama merespons. Coba lagi sebentar lagi.';
    if (k === 'format') return 'Jawaban dari Apps Script tidak dikenali. Pastikan alamatnya benar dan deployment diizinkan untuk “Siapa saja”.';
    if (k === 'config') return 'Spreadsheet belum terhubung.';
    if (code === 'unauthorized') return 'Kode akses salah atau belum diatur di Apps Script.';
    if (code === 'busy') return 'Spreadsheet sedang dipakai proses lain. Coba lagi.';
    if (code === 'bad_request') return 'Data ditolak oleh Spreadsheet. Muat ulang halaman lalu coba lagi.';
    return 'Spreadsheet mengembalikan kesalahan' + (code ? ' (' + code + ')' : '') + '.';
  }

  // Sends what changed since the last confirmed copy. On failure the working copy is rolled back, so the screen never shows data the spreadsheet does not have.
  function persist(okMessage) {
    const ops = L.diffState(synced, state);
    if (!ops.length) { if (okMessage) toast(okMessage); return Promise.resolve({ ok: true }); }
    busy = true;
    return api('write', { ops: ops }).then(function () {
      synced = clone(state); busy = false;
      if (okMessage) toast(okMessage);
      return { ok: true };
    }, function (err) {
      state = clone(synced); busy = false;
      return { ok: false, errors: { _: 'Perubahan tidak tersimpan. ' + errorText(err) } };
    });
  }

  function loadRemote(quiet) {
    if (!quiet) { conn = 'loading'; connError = ''; render(); }
    return api('read').then(function (res) {
      const d = res.data;
      const next = { version: 1, categories: d.categories, methods: d.methods, transactions: d.transactions, budgets: d.budgets, targets: d.targets };
      if (!L.isValidState(next)) throw { kind: 'format' };
      const changed = JSON.stringify(next) !== JSON.stringify(synced);
      synced = clone(next); state = clone(next); lastLoad = Date.now();
      const first = conn !== 'ready';
      conn = 'ready';
      if (first || changed) render();
      if (first) offerMigration();
      return true;
    }, function (err) {
      if (quiet) { toast(errorText(err), 'error'); return false; }
      conn = 'error'; connError = errorText(err); render();
      return false;
    });
  }

  // Data written by older versions lived only in this browser. If the spreadsheet is still empty, offer to move it over once.
  function legacyState() {
    try {
      if (localStorage.getItem(LEGACY_KEY + ':skipped')) return null;
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!L.isValidState(s)) return null;
      const n = s.categories.length + s.methods.length + s.transactions.length + s.budgets.length + s.targets.length;
      return n ? s : null;
    } catch (e) { return null; }
  }

  function offerMigration() {
    const old = legacyState();
    const empty = !synced.categories.length && !synced.methods.length && !synced.transactions.length && !synced.budgets.length && !synced.targets.length;
    if (!old || !empty) return;
    formDelete = null;
    $dlg.innerHTML = '<form class="dlg-form"><h2>Pindahkan data lama?</h2><p class="dlg-text">Di browser ini ada ' + old.transactions.length + ' transaksi dari versi sebelumnya, sedangkan Spreadsheet masih kosong. Pindahkan semuanya ke Spreadsheet?</p>' +
      '<p class="form-error" role="alert"></p><div class="dlg-actions"><button type="button" class="btn" data-action="skip-migration">Lewati</button><button type="submit" class="btn primary">Pindahkan</button></div></form>';
    $dlg.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      const form = e.target;
      setFormBusy(form, true, 'Memindahkan…');
      state = { version: 1, categories: old.categories, methods: old.methods, transactions: old.transactions, budgets: old.budgets, targets: old.targets };
      persist().then(function (r) {
        setFormBusy(form, false);
        if (!r.ok) { showErrors(form, r.errors); return; }
        try { localStorage.setItem(LEGACY_KEY + ':migrated', localStorage.getItem(LEGACY_KEY)); localStorage.removeItem(LEGACY_KEY); } catch (er) { /* ignore */ }
        closeDialog(); render(); toast('Data dipindahkan ke Spreadsheet');
      });
    });
    showDialog();
  }

  function setFormBusy(form, on, label) {
    form.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      if (on) { submit.dataset.label = submit.textContent; submit.textContent = label || 'Menyimpan…'; }
      else if (submit.dataset.label) submit.textContent = submit.dataset.label;
    }
  }

  // Keep this device current when it comes back to the foreground (another device may have written meanwhile).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || conn !== 'ready' || busy || $dlg.open) return;
    if (Date.now() - lastLoad > 60000) loadRemote(true);
  });
  $dlg.addEventListener('cancel', function (e) { if (busy) e.preventDefault(); });

  /* ---------- helpers ---------- */

  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  const byName = function (a, b) { return a.name.localeCompare(b.name); };
  const money = L.formatIDR;
  const plain = function (n) { return money(n).slice(3); }; // "1.500.000" without the Rp prefix

  function catName(id) { const c = L.byId(state.categories, id); return c ? c.name : 'Kategori tidak dikenal'; }
  function methodName(id) { const m = L.byId(state.methods, id); return m ? m.name : 'Metode tidak dikenal'; }

  let toastTimer = null;
  function toast(msg, kind) {
    $toast.innerHTML = (kind === 'error' ? '' : CHECK) + '<span>' + esc(msg) + '</span>';
    $toast.className = 'toast' + (kind === 'error' ? ' error' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 3000);
  }

  function bar(pct, status, label) {
    return '<span class="bar ' + status + '" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      Math.min(100, Math.round(pct)) + '"><span style="width:' + Math.min(100, pct) + '%"></span></span>';
  }

  /* ---------- dialog ---------- */

  function showDialog() {
    if (typeof $dlg.showModal === 'function') { if (!$dlg.open) $dlg.showModal(); }
    else $dlg.setAttribute('open', '');
  }
  // Content is replaced by whoever opens the dialog next, so nothing may clear it later
  // (a delayed "close" handler used to wipe the confirmation dialog right after it opened).
  function closeDialog() {
    if (typeof $dlg.close === 'function') { if ($dlg.open) $dlg.close(); }
    else $dlg.removeAttribute('open');
  }

  function field(label, name, control, hint) {
    return '<div class="field"><label for="f-' + name + '">' + label + '</label>' + control +
      (hint !== undefined ? '<p class="hint" id="hint-' + name + '">' + hint + '</p>' : '') +
      '<p class="field-error" data-error-for="' + name + '"></p></div>';
  }

  function seg(name, options, selected) {
    return '<div class="seg" role="radiogroup" id="f-' + name + '">' + options.map(function (o) {
      return '<label><input type="radio" name="' + name + '" value="' + o[0] + '"' + (o[0] === selected ? ' checked' : '') + '><span>' + o[1] + '</span></label>';
    }).join('') + '</div>';
  }

  function textInput(name, value, extra) {
    return '<input type="text" id="f-' + name + '" name="' + name + '" value="' + esc(value) + '" autocomplete="off" ' + (extra || '') + '>';
  }

  function moneyInput(name, value) {
    return '<div class="money"><span>Rp</span><input type="text" id="f-' + name + '" name="' + name +
      '" inputmode="numeric" autocomplete="off" placeholder="0" value="' + esc(value) + '"></div>';
  }

  // Live thousand separators that keep the caret next to the digit being edited.
  function formatMoneyField(el) {
    const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
    const digitsBefore = el.value.slice(0, caret).replace(/\D/g, '').length;
    const digits = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    el.value = out;
    let pos = 0, seen = 0;
    while (pos < out.length && seen < digitsBefore) { if (/\d/.test(out.charAt(pos))) seen++; pos++; }
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(pos, pos);
  }

  function showErrors(form, errors) {
    form.querySelectorAll('[data-error-for]').forEach(function (el) { el.textContent = ''; });
    const general = form.querySelector('.form-error');
    general.textContent = '';
    let first = null;
    Object.keys(errors).forEach(function (key) {
      const el = form.querySelector('[data-error-for="' + key + '"]');
      if (el) { el.textContent = errors[key]; if (!first) first = key; }
      else general.textContent = errors[key];
    });
    if (first) {
      const input = form.querySelector('#f-' + first + ', [name="' + first + '"]');
      if (input && typeof input.focus === 'function') input.focus();
    }
  }

  function openForm(title, body, submitLabel, onSubmit, onDelete) {
    formDelete = onDelete || null;
    $dlg.innerHTML = '<form class="dlg-form" novalidate><h2>' + esc(title) + '</h2><p class="form-error" role="alert"></p>' + body +
      '<div class="dlg-actions">' + (onDelete ? '<button type="button" class="link danger spacer" data-action="form-delete">Hapus</button>' : '') +
      '<button type="button" class="btn" data-action="close-dialog">Batal</button>' +
      '<button type="submit" class="btn primary">' + esc(submitLabel) + '</button></div></form>';
    const form = $dlg.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      const res = onSubmit(data);
      if (res && typeof res.then === 'function') {
        setFormBusy(form, true);
        res.then(function (r) {
          setFormBusy(form, false);
          if (r && r.ok === false) { showErrors(form, r.errors || {}); return; }
          closeDialog(); render();
        });
        return;
      }
      if (res && res.ok === false) { showErrors(form, res.errors || {}); return; }
      closeDialog();
      render();
    });
    showDialog();
    const first = form.querySelector('.money input, input[type="text"]');
    if (first && typeof first.focus === 'function') first.focus();
    return form;
  }

  function openMessage(title, message, actions) {
    formDelete = null;
    $dlg.innerHTML = '<div class="dlg-form"><h2>' + esc(title) + '</h2><p class="dlg-text">' + esc(message) + '</p><div class="dlg-actions">' +
      (actions || '') + '<button type="button" class="btn primary" data-action="close-dialog">OK</button></div></div>';
    showDialog();
  }

  function confirmDialog(title, message, onConfirm) {
    formDelete = null;
    $dlg.innerHTML = '<form class="dlg-form"><h2>' + esc(title) + '</h2><p class="dlg-text">' + esc(message) + '</p><p class="form-error" role="alert"></p><div class="dlg-actions">' +
      '<button type="button" class="btn" data-action="close-dialog">Batal</button><button type="submit" class="btn danger">Hapus</button></div></form>';
    $dlg.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      const form = e.target;
      const res = onConfirm();
      if (res && typeof res.then === 'function') {
        setFormBusy(form, true);
        res.then(function (r) {
          setFormBusy(form, false);
          if (r && r.ok === false) { showErrors(form, r.errors || {}); return; }
          closeDialog(); render();
        });
        return;
      }
      closeDialog();
      render();
    });
    showDialog();
  }

  /* ---------- shared view pieces ---------- */

  // The month title is itself the picker: one tap on it (calendar icon) opens the month chooser.
  function period(addAction, addWord) {
    const label = L.monthLabel(ui.month);
    return '<div class="period"><h1><button type="button" class="month-btn" data-action="open-month" aria-haspopup="dialog" aria-label="Pilih bulan, sekarang ' + esc(label) + '">' +
      '<span>' + esc(label) + '</span>' + CAL + '</button></h1>' +
      '<button type="button" class="btn primary" data-action="' + addAction + '">Tambah<span class="long"> ' + addWord + '</span></button></div>';
  }

  function paintMonths(year) {
    const names = [];
    for (let m = 1; m <= 12; m++) {
      const key = year + '-' + (m < 10 ? '0' + m : m);
      names.push('<button type="button" class="mo' + (key === ui.month ? ' on' : '') + '" data-action="pick-month" data-month="' + key + '" aria-pressed="' + (key === ui.month) + '">' +
        esc(L.monthLabel(key).split(' ')[0].slice(0, 3)) + '</button>');
    }
    document.getElementById('months').innerHTML = names.join('');
  }

  function openMonthPicker() {
    formDelete = null;
    const selYear = +ui.month.slice(0, 4), nowYear = +L.currentMonthKey().slice(0, 4);
    let years = '';
    for (let y = Math.min(selYear, nowYear) - 5; y <= Math.max(selYear, nowYear) + 5; y++) {
      years += '<option value="' + y + '"' + (y === selYear ? ' selected' : '') + '>' + y + '</option>';
    }
    $dlg.innerHTML = '<div class="dlg-form"><h2>Pilih bulan</h2>' +
      '<div class="field"><label for="f-year">Tahun</label><select id="f-year" data-year-pick>' + years + '</select></div>' +
      '<div class="months" id="months"></div>' +
      '<div class="dlg-actions"><button type="button" class="btn" data-action="close-dialog">Batal</button></div></div>';
    paintMonths(selYear);
    showDialog();
    const on = $dlg.querySelector('.mo.on');
    if (on) on.focus();
  }

  // All-time balance, independent of the month selected on the page.
  function openTotal() {
    const t = L.totalSummary(state);
    formDelete = null;
    $dlg.innerHTML = '<div class="dlg-form"><h2>Saldo Total</h2><p class="dlg-sub">Semua bulan yang tercatat, bukan hanya ' + esc(L.monthLabel(ui.month)) + '.</p>' +
      '<p class="label">Saldo keseluruhan</p><p class="hero-value total-value' + (t.balance < 0 ? ' neg' : '') + '">' + money(t.balance) + '</p>' +
      '<dl class="split"><div><dt>Total pemasukan</dt><dd class="pos">' + money(t.income) + '</dd></div><div><dt>Total pengeluaran</dt><dd class="neg">' + money(t.expense) + '</dd></div></dl>' +
      '<div class="dlg-actions"><button type="button" class="btn primary" data-action="close-dialog">Tutup</button></div></div>';
    showDialog();
  }

  function title(text, addAction, addLabel) {
    return '<div class="period"><h1>' + esc(text) + '</h1><button type="button" class="btn primary" data-action="' + addAction + '">' + addLabel + '</button></div>';
  }

  function txItem(t) {
    const income = t.type === 'income';
    return '<li><button type="button" class="item tx' + (t.id === flashId ? ' flash' : '') + '" data-action="edit-tx" data-id="' + t.id + '">' +
      '<span class="tx-main"><span class="tx-desc">' + esc(t.description) + '</span><span class="meta">' + esc(catName(t.categoryId)) + ' · ' + esc(methodName(t.methodId)) + '</span></span>' +
      '<span class="amt ' + (income ? 'pos' : 'neg') + '">' + (income ? '+' : '−') + money(t.amount) + '</span></button></li>';
  }

  // list is already sorted by date (newest first), so neighbours with the same date form a day.
  function txGroups(list) {
    const groups = [];
    list.forEach(function (t) {
      const g = groups[groups.length - 1];
      if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
    });
    return groups.map(function (g) {
      return '<section class="day"><h3>' + esc(L.formatDay(g.date)) + '</h3><ul class="list">' + g.items.map(txItem).join('') + '</ul></section>';
    }).join('');
  }

  function budgetItem(b, editable) {
    const p = L.budgetProgress(state, b);
    const name = catName(b.categoryId);
    const pct = L.formatPct(p.pct);
    const status = p.status === 'over' ? '<span class="neg">Melebihi anggaran · ' + pct + '% terpakai</span>'
      : p.status === 'warn' ? '<span class="warn">Peringatan · ' + pct + '% terpakai</span>'
      : '<span>' + pct + '% terpakai</span>';
    const left = p.remaining < 0 ? '<span class="neg">Lebih ' + money(-p.remaining) + '</span>' : '<span>Sisa ' + money(p.remaining) + '</span>';
    const inner = '<span class="line"><span class="name">' + esc(name) + '</span><span class="amt">' + money(p.spent) + ' <span class="of">dari ' + money(b.amount) + '</span></span></span>' +
      bar(p.pct, p.status, 'Anggaran ' + name) + '<span class="line sub">' + status + left + '</span>';
    return editable
      ? '<li><button type="button" class="item" data-action="edit-budget" data-id="' + b.id + '">' + inner + '</button></li>'
      : '<li><div class="item static">' + inner + '</div></li>';
  }

  /* ---------- views ---------- */

  function viewOverview() {
    const s = L.summarize(state, ui.month);
    const budgets = L.budgetsForMonth(state, ui.month);
    const recent = L.filterTransactions(state, { month: ui.month }).slice(0, 5);
    const missing = !state.categories.length && !state.methods.length ? 'kategori dan metode pembayaran'
      : !state.categories.length ? 'kategori' : !state.methods.length ? 'metode pembayaran' : '';

    let h = period('add-tx', 'transaksi');
    h += '<section class="hero"><div class="hero-head"><p class="label">Saldo</p><button type="button" class="link" data-action="show-total">Saldo Total</button></div><p class="hero-value' + (s.balance < 0 ? ' neg' : '') + '">' + money(s.balance) + '</p>' +
      '<dl class="split"><div><dt>Pemasukan</dt><dd class="pos">' + money(s.income) + '</dd></div><div><dt>Pengeluaran</dt><dd class="neg">' + money(s.expense) + '</dd></div></dl></section>';

    if (missing) {
      h += '<p class="notice">Untuk mencatat transaksi, tambahkan dulu ' + missing + ' di <button type="button" class="link" data-action="go" data-view="manage">Kelola</button>.</p>';
    }

    h += '<section class="sec"><div class="sec-head"><h2>Anggaran</h2><button type="button" class="link" data-action="go" data-view="budgets">Semua anggaran</button></div>' +
      (budgets.length ? '<ul class="list">' + budgets.map(function (b) { return budgetItem(b, false); }).join('') + '</ul>' : '<p class="empty">Belum ada anggaran untuk ' + esc(L.monthLabel(ui.month)) + '.</p>') + '</section>';

    h += '<section class="sec"><div class="sec-head"><h2>Transaksi terbaru</h2><button type="button" class="link" data-action="go" data-view="transactions">Semua transaksi</button></div>' +
      (recent.length ? txGroups(recent) : '<p class="empty">Belum ada transaksi di ' + esc(L.monthLabel(ui.month)) + '.</p>') + '</section>';
    return h;
  }

  function viewTransactions() {
    const catsForFilter = state.categories.filter(function (c) { return ui.txType === 'all' || c.type === ui.txType; }).sort(byName);
    if (ui.txCategory !== 'all' && !catsForFilter.some(function (c) { return c.id === ui.txCategory; })) ui.txCategory = 'all';

    const inMonth = L.filterTransactions(state, { month: ui.month });
    const list = L.filterTransactions(state, { month: ui.month, type: ui.txType, categoryId: ui.txCategory });
    const filtersActive = ui.txType !== 'all' || ui.txCategory !== 'all';

    function opt(v, label, sel) { return '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
    let catOpts = opt('all', 'Semua kategori', ui.txCategory === 'all');
    if (ui.txType === 'all') {
      ['income', 'expense'].forEach(function (type) {
        const g = catsForFilter.filter(function (c) { return c.type === type; });
        if (g.length) catOpts += '<optgroup label="' + L.typeLabel(type) + '">' + g.map(function (c) { return opt(c.id, c.name, ui.txCategory === c.id); }).join('') + '</optgroup>';
      });
    } else {
      catOpts += catsForFilter.map(function (c) { return opt(c.id, c.name, ui.txCategory === c.id); }).join('');
    }

    let h = period('add-tx', 'transaksi');
    h += '<div class="toolbar"><select data-filter="type" aria-label="Filter jenis">' +
      opt('all', 'Semua jenis', ui.txType === 'all') + opt('income', 'Pemasukan', ui.txType === 'income') + opt('expense', 'Pengeluaran', ui.txType === 'expense') +
      '</select><select data-filter="category" aria-label="Filter kategori">' + catOpts + '</select>' +
      (filtersActive ? '<button type="button" class="link" data-action="clear-filters">Reset</button>' : '') + '</div>';

    if (list.length) {
      h += '<p class="count">' + (filtersActive ? list.length + ' dari ' + inMonth.length : list.length) + ' transaksi</p>' + txGroups(list) +
        '<p class="foot-hint">Ketuk transaksi untuk mengubah atau menghapusnya.</p>';
    } else if (inMonth.length && filtersActive) {
      h += '<p class="empty">Tidak ada transaksi yang cocok dengan filter. <button type="button" class="link" data-action="clear-filters">Reset filter</button></p>';
    } else if (!state.categories.length || !state.methods.length) {
      h += '<p class="empty">Tambahkan dulu kategori dan metode pembayaran di <button type="button" class="link" data-action="go" data-view="manage">Kelola</button>.</p>';
    } else {
      h += '<p class="empty">Belum ada transaksi di ' + esc(L.monthLabel(ui.month)) + '.</p>';
    }
    return h;
  }

  function viewBudgets() {
    const budgets = L.budgetsForMonth(state, ui.month);
    const prev = L.shiftMonth(ui.month, -1);
    const copyable = L.copyableBudgets(state, prev, ui.month).length;
    const hasExpenseCats = state.categories.some(function (c) { return c.type === 'expense'; });
    const copyLink = copyable ? '<button type="button" class="link" data-action="copy-budgets">Salin dari ' + esc(L.monthLabel(prev)) + '</button>' : '';

    let h = period('add-budget', 'anggaran');
    if (budgets.length) {
      h += '<ul class="list">' + budgets.map(function (b) { return budgetItem(b, true); }).join('') + '</ul>';
      h += '<p class="foot-hint">' + (copyable ? copyLink : 'Ketuk anggaran untuk mengubah atau menghapusnya.') + '</p>';
    } else if (!hasExpenseCats) {
      h += '<p class="empty">Anggaran memakai kategori pengeluaran. Buat dulu di <button type="button" class="link" data-action="go" data-view="manage">Kelola</button>.</p>';
    } else {
      h += '<p class="empty">Belum ada anggaran untuk ' + esc(L.monthLabel(ui.month)) + '. ' + copyLink + '</p>';
    }
    return h;
  }

  function viewTargets() {
    let h = title('Target', 'add-target', 'Tambah<span class="long"> target</span>');
    if (!state.targets.length) {
      h += state.categories.length
        ? '<p class="empty">Belum ada target.</p>'
        : '<p class="empty">Target memakai salah satu kategori. Buat dulu di <button type="button" class="link" data-action="go" data-view="manage">Kelola</button>.</p>';
      return h;
    }
    h += '<ul class="list">' + state.targets.slice().sort(byName).map(function (t) {
      const p = L.targetProgress(t);
      return '<li><button type="button" class="item" data-action="edit-target" data-id="' + t.id + '">' +
        '<span class="line"><span class="name">' + esc(t.name) + '</span><span class="amt">' + money(t.saved) + ' <span class="of">dari ' + money(t.target) + '</span></span></span>' +
        bar(p.pct, 'ok', 'Progres ' + t.name) +
        '<span class="line sub"><span>' + esc(catName(t.categoryId)) + ' · ' + L.formatPct(p.pct) + '%</span><span' + (p.reached ? ' class="pos"' : '') + '>' + (p.reached ? 'Tercapai' : 'Kurang ' + money(p.remaining)) + '</span></span></button></li>';
    }).join('') + '</ul><p class="foot-hint">Ketuk target untuk memperbarui dana terkumpul, mengubah, atau menghapusnya.</p>';
    return h;
  }

  function viewManage() {
    const cats = state.categories.slice().sort(byName);
    function catSection(type) {
      const list = cats.filter(function (c) { return c.type === type; });
      return '<section class="sec"><div class="sec-head"><h2>Kategori ' + L.typeLabel(type).toLowerCase() + '</h2><button type="button" class="link" data-action="add-category" data-type="' + type + '">Tambah</button></div>' +
        (list.length ? '<ul class="list">' + list.map(function (c) {
          const usage = L.describeCategoryUsage(L.categoryUsage(state, c.id));
          return '<li><button type="button" class="item row" data-action="edit-category" data-id="' + c.id + '"><span class="name">' + esc(c.name) + '</span><span class="meta">' + (usage ? esc(usage) : 'Belum dipakai') + '</span></button></li>';
        }).join('') + '</ul>' : '<p class="empty">Belum ada kategori ' + L.typeLabel(type).toLowerCase() + '.</p>') + '</section>';
    }
    const methods = state.methods.slice().sort(byName);
    return '<div class="period"><h1>Kelola</h1></div>' + catSection('income') + catSection('expense') +
      '<section class="sec"><div class="sec-head"><h2>Metode pembayaran</h2><button type="button" class="link" data-action="add-method">Tambah</button></div>' +
      (methods.length ? '<ul class="list">' + methods.map(function (m) {
        const n = L.methodUsage(state, m.id);
        return '<li><button type="button" class="item row" data-action="edit-method" data-id="' + m.id + '"><span class="name">' + esc(m.name) + '</span><span class="meta">' + (n ? n + ' transaksi' : 'Belum dipakai') + '</span></button></li>';
      }).join('') + '</ul>' : '<p class="empty">Belum ada metode pembayaran.</p>') + '</section>' +
      '<p class="foot-hint">Ketuk item untuk mengubah nama atau menghapusnya. Item yang sedang dipakai tidak bisa dihapus.</p>' +
      '<section class="sec"><div class="sec-head"><h2>Spreadsheet</h2></div><p class="conn-text">Semua data tersimpan di Google Spreadsheet milikmu dan dibuka dari sana di perangkat mana pun.</p>' +
      '<div class="conn-actions"><button type="button" class="btn" data-action="reload">Muat ulang data</button><button type="button" class="btn" data-action="edit-connection">Ubah koneksi</button></div></section>';
  }

  /* ---------- render ---------- */

  function gateView() {
    if (conn === 'loading') return '<div class="period"><h1>MyBudget</h1></div><p class="empty" role="status">Memuat data dari Google Spreadsheet…</p>';
    if (conn === 'error') {
      return '<div class="period"><h1>MyBudget</h1></div><div class="banner"><span>' + esc(connError) + '</span></div>' +
        '<div class="conn-actions"><button type="button" class="btn primary" data-action="retry-load">Coba lagi</button>' +
        '<button type="button" class="btn" data-action="edit-connection">Ubah koneksi</button></div>';
    }
    const cfg = getConfig();
    return '<div class="period"><h1>Hubungkan Spreadsheet</h1></div>' +
      '<p class="conn-text">Data MyBudget disimpan di Google Spreadsheet milikmu. Tempel alamat Web app dari Apps Script dan kode akses yang kamu buat saat memasang <code>Code.gs</code>.</p>' +
      '<form id="connect" class="conn-form" novalidate><p class="form-error" role="alert"></p>' +
      field('Alamat Web app', 'url', textInput('url', cfg ? cfg.url : '', 'inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false" autocapitalize="off"')) +
      field('Kode akses', 'token', '<input type="password" id="f-token" name="token" value="' + esc(cfg ? cfg.token : '') + '" autocomplete="off" spellcheck="false">') +
      '<div class="conn-actions"><button type="submit" class="btn primary">Hubungkan</button>' +
      (cfg ? '<button type="button" class="btn" data-action="cancel-connection">Batal</button>' : '') + '</div></form>';
  }

  function connectSubmit(form) {
    const url = form.elements.url.value.trim(), token = form.elements.token.value.trim();
    const errors = {};
    if (!url) errors.url = 'Masukkan alamat Web app.';
    else if (!URL_RE.test(url)) errors.url = 'Alamat harus berbentuk https://script.google.com/macros/s/…/exec';
    if (!token) errors.token = 'Masukkan kode akses.';
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    setFormBusy(form, true, 'Menghubungkan…');
    api('ping', {}, { url: url, token: token }).then(function () {
      if (!setConfig({ url: url, token: token })) { setFormBusy(form, false); showErrors(form, { _: 'Browser tidak mengizinkan menyimpan pengaturan koneksi.' }); return; }
      return loadRemote(false);
    }, function (err) {
      setFormBusy(form, false);
      showErrors(form, { _: errorText(err) });
    });
  }

  function render() {
    $nav.style.display = conn === 'ready' ? '' : 'none';
    if (conn !== 'ready') {
      $view.innerHTML = gateView();
      return;
    }
    $nav.querySelectorAll('button').forEach(function (b) {
      const active = b.dataset.view === ui.view;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const views = { overview: viewOverview, transactions: viewTransactions, budgets: viewBudgets, targets: viewTargets, manage: viewManage };
    $view.innerHTML = (notice ? '<div class="banner"><span>' + esc(notice) + '</span><button type="button" class="link" data-action="dismiss-notice">Tutup</button></div>' : '') + views[ui.view]();
    flashId = null; // the highlight plays once, on this render only
  }

  /* ---------- forms ---------- */

  function defaultDate() {
    const today = L.todayISO();
    return L.monthKey(today) === ui.month ? today : ui.month + '-01';
  }

  function lastMethodId() {
    let latest = null;
    state.transactions.forEach(function (t) {
      if (L.byId(state.methods, t.methodId) && (!latest || (t.createdAt || 0) > (latest.createdAt || 0))) latest = t;
    });
    return latest ? latest.methodId : '';
  }

  function catOptionsHtml(type, selected) {
    return '<option value="">Pilih kategori</option>' + state.categories.filter(function (c) { return c.type === type; }).sort(byName).map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
  }

  function openTransactionForm(tx) {
    if (!state.categories.length || !state.methods.length) {
      const missing = !state.categories.length && !state.methods.length ? 'kategori dan metode pembayaran' : (!state.categories.length ? 'kategori' : 'metode pembayaran');
      openMessage('Siapkan dulu', 'Untuk mencatat transaksi, tambahkan ' + missing + ' di Kelola.',
        '<button type="button" class="btn" data-action="go" data-view="manage">Buka Kelola</button>');
      return;
    }
    const t = tx || { type: 'expense', amount: '', description: '', categoryId: '', date: defaultDate(), methodId: lastMethodId() };
    const methodOpts = '<option value="">Pilih metode pembayaran</option>' + state.methods.slice().sort(byName).map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === t.methodId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('');

    const body =
      field('Jenis', 'type', seg('type', [['expense', 'Pengeluaran'], ['income', 'Pemasukan']], t.type)) +
      field('Jumlah', 'amount', moneyInput('amount', tx ? plain(tx.amount) : '')) +
      field('Deskripsi', 'description', textInput('description', t.description, 'maxlength="100"')) +
      field('Kategori', 'categoryId', '<select id="f-categoryId" name="categoryId"></select>', '') +
      field('Tanggal', 'date', '<input type="date" id="f-date" name="date" value="' + esc(t.date) + '">') +
      field('Metode pembayaran', 'methodId', '<select id="f-methodId" name="methodId">' + methodOpts + '</select>');

    const form = openForm(tx ? 'Ubah transaksi' : 'Transaksi baru', body, 'Simpan', function (d) {
      const res = L.saveTransaction(state, { id: tx && tx.id, type: d.type, amount: d.amount, description: d.description, categoryId: d.categoryId, date: d.date, methodId: d.methodId });
      if (!res.ok) return res;
      const m = L.monthKey(res.item.date), newId = tx ? null : res.item.id;
      return persist().then(function (r) {
        if (!r.ok) return r;
        const moved = m !== ui.month;
        ui.month = m;
        if (newId) flashId = newId;
        toast('Transaksi disimpan' + (moved ? ' di ' + L.monthLabel(m) : ''));
        return r;
      });
    }, tx ? function () { removeTransaction(tx.id); } : null);

    const catSel = form.querySelector('#f-categoryId');
    const catHint = form.querySelector('#hint-categoryId');
    function syncCategories(keepSelection) {
      const type = form.elements.type.value;
      catSel.innerHTML = catOptionsHtml(type, keepSelection ? t.categoryId : '');
      const has = state.categories.some(function (c) { return c.type === type; });
      catHint.innerHTML = has ? '' : 'Belum ada kategori ' + L.typeLabel(type).toLowerCase() + '. <button type="button" class="link" data-action="go" data-view="manage">Buat sekarang</button>';
    }
    syncCategories(true);
    form.querySelectorAll('input[name="type"]').forEach(function (r) { r.addEventListener('change', function () { syncCategories(t.type === form.elements.type.value); }); });
  }

  function openCategoryForm(cat, presetType) {
    const type = cat ? cat.type : (presetType || 'expense');
    const usage = cat ? L.categoryUsage(state, cat.id) : null;
    const locked = !!cat && (usage.transactions > 0 || usage.budgets > 0);
    const typeControl = locked
      ? '<input type="hidden" name="type" value="' + type + '"><p class="static-text" id="f-type">' + L.typeLabel(type) + '</p>'
      : seg('type', [['expense', 'Pengeluaran'], ['income', 'Pemasukan']], type);
    const body = field('Nama', 'name', textInput('name', cat ? cat.name : '', 'maxlength="40"')) +
      field('Jenis', 'type', typeControl, locked ? 'Terkunci selama kategori dipakai transaksi atau anggaran.' : undefined);
    openForm(cat ? 'Ubah kategori' : 'Kategori baru', body, 'Simpan', function (d) {
      const res = L.saveCategory(state, { id: cat && cat.id, name: d.name, type: d.type });
      if (!res.ok) return res;
      return persist('Kategori disimpan');
    }, cat ? function () { removeCategory(cat.id); } : null);
  }

  function openMethodForm(m) {
    openForm(m ? 'Ubah metode pembayaran' : 'Metode pembayaran baru',
      field('Nama', 'name', textInput('name', m ? m.name : '', 'maxlength="40"')),
      'Simpan', function (d) {
        const res = L.saveMethod(state, { id: m && m.id, name: d.name });
        if (!res.ok) return res;
        return persist('Metode pembayaran disimpan');
      }, m ? function () { removeMethod(m.id); } : null);
  }

  function openBudgetForm(b) {
    const used = {};
    L.budgetsForMonth(state, ui.month).forEach(function (x) { if (!b || x.id !== b.id) used[x.categoryId] = true; });
    const options = state.categories.filter(function (c) { return c.type === 'expense' && !used[c.id]; }).sort(byName);
    if (!options.length) {
      const none = !state.categories.some(function (c) { return c.type === 'expense'; });
      openMessage(none ? 'Belum ada kategori pengeluaran' : 'Semua kategori sudah punya anggaran',
        none ? 'Anggaran memakai kategori pengeluaran. Buat dulu di Kelola.' : 'Setiap kategori pengeluaran sudah punya anggaran untuk ' + L.monthLabel(ui.month) + '.',
        none ? '<button type="button" class="btn" data-action="go" data-view="manage">Buka Kelola</button>' : '');
      return;
    }
    const sel = '<select id="f-categoryId" name="categoryId"><option value="">Pilih kategori pengeluaran</option>' + options.map(function (c) {
      return '<option value="' + c.id + '"' + (b && b.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('') + '</select>';
    const body = '<p class="dlg-sub">' + esc(L.monthLabel(b ? b.month : ui.month)) + '</p>' +
      field('Kategori', 'categoryId', sel) + field('Nominal anggaran', 'amount', moneyInput('amount', b ? plain(b.amount) : ''));
    openForm(b ? 'Ubah anggaran' : 'Anggaran baru', body, 'Simpan', function (d) {
      const res = L.saveBudget(state, { id: b && b.id, month: b ? b.month : ui.month, categoryId: d.categoryId, amount: d.amount });
      if (!res.ok) return res;
      return persist('Anggaran disimpan');
    }, b ? function () { removeBudget(b.id); } : null);
  }

  function openTargetForm(t) {
    if (!state.categories.length) {
      openMessage('Belum ada kategori', 'Target memakai salah satu kategori. Buat dulu di Kelola.',
        '<button type="button" class="btn" data-action="go" data-view="manage">Buka Kelola</button>');
      return;
    }
    function group(type) {
      const l = state.categories.filter(function (c) { return c.type === type; }).sort(byName);
      return l.length ? '<optgroup label="' + L.typeLabel(type) + '">' + l.map(function (c) {
        return '<option value="' + c.id + '"' + (t && t.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>' : '';
    }
    const sel = '<select id="f-categoryId" name="categoryId"><option value="">Pilih kategori</option>' + group('expense') + group('income') + '</select>';
    const body = field('Nama target', 'name', textInput('name', t ? t.name : '', 'maxlength="60"')) +
      field('Kategori', 'categoryId', sel) +
      field('Nominal target', 'target', moneyInput('target', t ? plain(t.target) : '')) +
      field('Dana terkumpul', 'saved', moneyInput('saved', t ? plain(t.saved) : ''), 'Kosongkan jika belum ada.');
    openForm(t ? 'Ubah target' : 'Target baru', body, 'Simpan', function (d) {
      const res = L.saveTarget(state, { id: t && t.id, name: d.name, categoryId: d.categoryId, target: d.target, saved: d.saved });
      if (!res.ok) return res;
      return persist('Target disimpan');
    }, t ? function () { removeTarget(t.id); } : null);
  }

  /* ---------- delete flows ---------- */

  function removeCategory(id) {
    const cat = L.byId(state.categories, id);
    if (!cat) return;
    const blocked = L.deleteCategory(JSON.parse(JSON.stringify(state)), id); // dry run on a copy
    if (!blocked.ok) { openMessage('Kategori tidak bisa dihapus', blocked.errors._); return; }
    confirmDialog('Hapus kategori?', '“' + cat.name + '” tidak dipakai di mana pun. Tindakan ini tidak bisa dibatalkan.', function () {
      L.deleteCategory(state, id); return persist('Kategori dihapus');
    });
  }

  function removeMethod(id) {
    const m = L.byId(state.methods, id);
    if (!m) return;
    const blocked = L.deleteMethod(JSON.parse(JSON.stringify(state)), id);
    if (!blocked.ok) { openMessage('Metode pembayaran tidak bisa dihapus', blocked.errors._); return; }
    confirmDialog('Hapus metode pembayaran?', '“' + m.name + '” tidak dipakai di transaksi mana pun. Tindakan ini tidak bisa dibatalkan.', function () {
      L.deleteMethod(state, id); return persist('Metode pembayaran dihapus');
    });
  }

  function removeTransaction(id) {
    const t = L.byId(state.transactions, id);
    if (!t) return;
    confirmDialog('Hapus transaksi?', '“' + t.description + '”, ' + money(t.amount) + ' pada ' + L.formatDate(t.date) + '. Total dan anggaran akan ikut diperbarui. Tindakan ini tidak bisa dibatalkan.', function () {
      L.deleteTransaction(state, id); return persist('Transaksi dihapus');
    });
  }

  function removeBudget(id) {
    const b = L.byId(state.budgets, id);
    if (!b) return;
    confirmDialog('Hapus anggaran?', 'Anggaran ' + L.monthLabel(b.month) + ' untuk “' + catName(b.categoryId) + '” akan dihapus. Transaksi tidak terpengaruh.', function () {
      L.deleteBudget(state, id); return persist('Anggaran dihapus');
    });
  }

  function removeTarget(id) {
    const t = L.byId(state.targets, id);
    if (!t) return;
    confirmDialog('Hapus target?', '“' + t.name + '” beserta dana terkumpulnya akan dihapus. Tindakan ini tidak bisa dibatalkan.', function () {
      L.deleteTarget(state, id); return persist('Target dihapus');
    });
  }

  /* ---------- events ---------- */

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    if (busy && el.dataset.action !== 'close-dialog') return;
    switch (el.dataset.action) {
      case 'show-total': openTotal(); break;
      case 'retry-load': loadRemote(false); break;
      case 'reload': toast('Memuat ulang…'); loadRemote(true).then(function (ok) { if (ok) { render(); toast('Data dimuat ulang'); } }); break;
      case 'edit-connection': conn = 'setup'; render(); break;
      case 'cancel-connection': if (lastLoad) { conn = 'ready'; render(); } else loadRemote(false); break;
      case 'skip-migration': try { localStorage.setItem(LEGACY_KEY + ':skipped', '1'); } catch (er) { /* ignore */ } closeDialog(); break;
      case 'go': closeDialog(); ui.view = el.dataset.view; render(); window.scrollTo(0, 0); break;
      case 'open-month': openMonthPicker(); break;
      case 'pick-month': ui.month = el.dataset.month; closeDialog(); render(); break;
      case 'close-dialog': closeDialog(); break;
      case 'form-delete': { const fn = formDelete; closeDialog(); if (fn) fn(); break; }
      case 'dismiss-notice': notice = ''; render(); break;
      case 'clear-filters': ui.txType = 'all'; ui.txCategory = 'all'; render(); break;
      case 'add-tx': openTransactionForm(null); break;
      case 'edit-tx': openTransactionForm(L.byId(state.transactions, id)); break;
      case 'add-category': openCategoryForm(null, el.dataset.type); break;
      case 'edit-category': openCategoryForm(L.byId(state.categories, id)); break;
      case 'add-method': openMethodForm(null); break;
      case 'edit-method': openMethodForm(L.byId(state.methods, id)); break;
      case 'add-budget': openBudgetForm(null); break;
      case 'edit-budget': openBudgetForm(L.byId(state.budgets, id)); break;
      case 'copy-budgets': {
        const n = L.copyBudgets(state, L.shiftMonth(ui.month, -1), ui.month);
        persist().then(function (r) {
          render();
          if (r.ok) toast(n + ' anggaran disalin'); else toast(r.errors._, 'error');
        });
        break;
      }
      case 'add-target': openTargetForm(null); break;
      case 'edit-target': openTargetForm(L.byId(state.targets, id)); break;
    }
  });

  function clearFieldError(e) {
    const f = e.target.closest && e.target.closest('.field');
    const er = f && f.querySelector('.field-error');
    if (er) er.textContent = '';
  }

  document.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('.money input')) formatMoneyField(e.target);
    clearFieldError(e);
  });

  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('[data-year-pick]')) { paintMonths(+e.target.value); return; }
    const f = e.target.dataset && e.target.dataset.filter;
    if (f === 'type') { ui.txType = e.target.value; render(); }
    if (f === 'category') { ui.txCategory = e.target.value; render(); }
    clearFieldError(e);
  });

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'connect') { e.preventDefault(); connectSubmit(e.target); }
  });

  if (getConfig()) loadRemote(false); else { conn = 'setup'; render(); }
})();
