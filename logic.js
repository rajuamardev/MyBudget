/* MyBudget – pure business logic (no DOM). Works in the browser and in Node for testing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MyBudgetLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  /* ---------- basics ---------- */

  function emptyState() {
    return { version: 1, categories: [], methods: [], transactions: [], budgets: [], targets: [] };
  }

  function isValidState(s) {
    return !!s && typeof s === 'object' &&
      ['categories', 'methods', 'transactions', 'budgets', 'targets'].every(function (k) { return Array.isArray(s[k]); });
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function byId(list, id) { return list.find(function (x) { return x.id === id; }) || null; }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function hasKeys(o) { return Object.keys(o).length > 0; }
  function count(n, word) { return n + ' ' + word; }
  function sameName(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
  function typeLabel(type) { return type === 'income' ? 'Pemasukan' : 'Pengeluaran'; }

  /* ---------- dates ---------- */

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function monthKey(iso) { return String(iso).slice(0, 7); }
  function currentMonthKey() { return monthKey(todayISO()); }
  function isValidMonth(k) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(k || ''); }
  function isValidDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1900 || y > 2100) return false;
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }
  function shiftMonth(key, delta) {
    const y = +key.slice(0, 4), m = +key.slice(5, 7);
    const total = y * 12 + (m - 1) + delta;
    return Math.floor(total / 12) + '-' + pad((total % 12) + 1);
  }
  function monthLabel(key) { return MONTHS[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4); }
  function formatDate(iso) { return +iso.slice(8, 10) + ' ' + MONTHS_SHORT[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); }
  function formatDay(iso) {
    const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    return DAYS_SHORT[d.getDay()] + ', ' + (+iso.slice(8, 10)) + ' ' + MONTHS_SHORT[+iso.slice(5, 7) - 1];
  }

  /* ---------- money ---------- */

  function parseAmount(raw, opts) {
    opts = opts || {};
    let s = String(raw == null ? '' : raw).trim().replace(/^rp\.?\s*/i, '');
    if (s === '') return opts.allowEmpty ? { ok: true, value: 0 } : { ok: false, error: 'Masukkan jumlah.' };
    if (s.indexOf('-') !== -1) return { ok: false, error: 'Jumlah harus positif.' };
    if (/[^0-9.,\s]/.test(s)) return { ok: false, error: 'Gunakan angka saja.' };
    if (/[.,]\d{1,2}$/.test(s)) return { ok: false, error: 'Gunakan rupiah utuh (tanpa desimal).' };
    const n = Number(s.replace(/[^0-9]/g, ''));
    if (!isFinite(n) || n > 1e13) return { ok: false, error: 'Jumlah terlalu besar.' };
    if (n === 0 && !opts.allowZero) return { ok: false, error: 'Jumlah harus lebih dari nol.' };
    return { ok: true, value: n };
  }

  function formatIDR(n) {
    const neg = n < 0;
    const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + 'Rp ' + s;
  }

  function formatPct(p) {
    return String(Math.floor(p * 10) / 10).replace('.', ',');
  }

  /* ---------- queries & calculations ---------- */

  function sortTx(a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  }

  function filterTransactions(state, f) {
    f = f || {};
    return state.transactions.filter(function (t) {
      if (f.month && monthKey(t.date) !== f.month) return false;
      if (f.type && f.type !== 'all' && t.type !== f.type) return false;
      if (f.categoryId && f.categoryId !== 'all' && t.categoryId !== f.categoryId) return false;
      return true;
    }).sort(sortTx);
  }

  function summarize(state, month) {
    let income = 0, expense = 0;
    state.transactions.forEach(function (t) {
      if (monthKey(t.date) !== month) return;
      if (t.type === 'income') income += t.amount;
      else if (t.type === 'expense') expense += t.amount;
    });
    return { income: income, expense: expense, balance: income - expense };
  }

  // Totals across every month, ignoring whichever month is selected.
  function totalSummary(state) {
    let income = 0, expense = 0;
    state.transactions.forEach(function (t) {
      if (t.type === 'income') income += t.amount;
      else if (t.type === 'expense') expense += t.amount;
    });
    return { income: income, expense: expense, balance: income - expense };
  }

  // What changed between two states, as write operations for the spreadsheet backend (matched by id).
  const COLLECTIONS = ['categories', 'methods', 'transactions', 'budgets', 'targets'];
  function diffState(before, after) {
    const ops = [];
    COLLECTIONS.forEach(function (c) {
      const old = {}, seen = {};
      before[c].forEach(function (x) { old[x.id] = JSON.stringify(x); });
      after[c].forEach(function (x) {
        seen[x.id] = true;
        if (old[x.id] !== JSON.stringify(x)) ops.push({ c: c, op: 'put', row: x });
      });
      before[c].forEach(function (x) { if (!seen[x.id]) ops.push({ c: c, op: 'del', id: x.id }); });
    });
    return ops;
  }

  function spentFor(state, month, categoryId) {
    let sum = 0;
    state.transactions.forEach(function (t) {
      if (t.type === 'expense' && t.categoryId === categoryId && monthKey(t.date) === month) sum += t.amount;
    });
    return sum;
  }

  function budgetsForMonth(state, month) {
    return state.budgets.filter(function (b) { return b.month === month; }).sort(function (a, b) {
      const ca = byId(state.categories, a.categoryId), cb = byId(state.categories, b.categoryId);
      return (ca ? ca.name : '').localeCompare(cb ? cb.name : '');
    });
  }

  function budgetProgress(state, b) {
    const spent = spentFor(state, b.month, b.categoryId);
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    // integer comparisons so 80% / 100% boundaries are exact
    const status = spent > b.amount ? 'over' : (spent * 100 >= b.amount * 80 ? 'warn' : 'ok');
    return { spent: spent, remaining: b.amount - spent, pct: pct, status: status };
  }

  function targetProgress(t) {
    return {
      pct: t.target > 0 ? (t.saved / t.target) * 100 : 0,
      remaining: Math.max(0, t.target - t.saved),
      reached: t.saved >= t.target
    };
  }

  /* ---------- usage (protects against data loss) ---------- */

  function categoryUsage(state, id) {
    return {
      transactions: state.transactions.filter(function (t) { return t.categoryId === id; }).length,
      budgets: state.budgets.filter(function (b) { return b.categoryId === id; }).length,
      targets: state.targets.filter(function (t) { return t.categoryId === id; }).length
    };
  }

  function describeCategoryUsage(u) {
    const parts = [];
    if (u.transactions) parts.push(count(u.transactions, 'transaksi'));
    if (u.budgets) parts.push(count(u.budgets, 'anggaran'));
    if (u.targets) parts.push(count(u.targets, 'target'));
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' dan ' + parts[parts.length - 1];
  }

  function methodUsage(state, id) {
    return state.transactions.filter(function (t) { return t.methodId === id; }).length;
  }

  /* ---------- categories ---------- */

  function saveCategory(state, input) {
    const errors = {};
    const name = String(input.name || '').trim();
    const type = input.type;
    if (!name) errors.name = 'Masukkan nama kategori.';
    else if (name.length > 40) errors.name = 'Nama maksimal 40 karakter.';
    if (type !== 'income' && type !== 'expense') errors.type = 'Pilih pemasukan atau pengeluaran.';

    const existing = input.id ? byId(state.categories, input.id) : null;
    if (input.id && !existing) return { ok: false, errors: { _: 'Kategori tidak ditemukan.' } };

    if (!errors.name && !errors.type) {
      const dup = state.categories.some(function (c) {
        return c.id !== input.id && c.type === type && sameName(c.name, name);
      });
      if (dup) errors.name = 'Kategori ' + typeLabel(type).toLowerCase() + ' dengan nama ini sudah ada.';
    }
    if (existing && !errors.type && existing.type !== type) {
      const u = categoryUsage(state, existing.id);
      if (u.transactions || u.budgets) errors.type = 'Jenis tidak bisa diubah selama kategori dipakai transaksi atau anggaran.';
    }
    if (hasKeys(errors)) return { ok: false, errors: errors };

    if (existing) { existing.name = name; existing.type = type; return { ok: true, item: existing }; }
    const item = { id: uid(), name: name, type: type };
    state.categories.push(item);
    return { ok: true, item: item };
  }

  function deleteCategory(state, id) {
    const cat = byId(state.categories, id);
    if (!cat) return { ok: false, errors: { _: 'Kategori tidak ditemukan.' } };
    const u = categoryUsage(state, id);
    const text = describeCategoryUsage(u);
    if (text) {
      return { ok: false, usage: u, errors: { _: '“' + cat.name + '” dipakai oleh ' + text + ', jadi tidak bisa dihapus. Ganti namanya, atau hapus dulu data yang memakainya.' } };
    }
    state.categories = state.categories.filter(function (c) { return c.id !== id; });
    return { ok: true };
  }

  /* ---------- payment methods ---------- */

  function saveMethod(state, input) {
    const errors = {};
    const name = String(input.name || '').trim();
    if (!name) errors.name = 'Masukkan nama metode pembayaran.';
    else if (name.length > 40) errors.name = 'Nama maksimal 40 karakter.';
    const existing = input.id ? byId(state.methods, input.id) : null;
    if (input.id && !existing) return { ok: false, errors: { _: 'Metode pembayaran tidak ditemukan.' } };
    if (!errors.name && state.methods.some(function (m) { return m.id !== input.id && sameName(m.name, name); })) {
      errors.name = 'Metode pembayaran dengan nama ini sudah ada.';
    }
    if (hasKeys(errors)) return { ok: false, errors: errors };
    if (existing) { existing.name = name; return { ok: true, item: existing }; }
    const item = { id: uid(), name: name };
    state.methods.push(item);
    return { ok: true, item: item };
  }

  function deleteMethod(state, id) {
    const m = byId(state.methods, id);
    if (!m) return { ok: false, errors: { _: 'Metode pembayaran tidak ditemukan.' } };
    const n = methodUsage(state, id);
    if (n) {
      return { ok: false, errors: { _: '“' + m.name + '” dipakai oleh ' + count(n, 'transaksi') + ', jadi tidak bisa dihapus. Ganti namanya, atau hapus dulu transaksi tersebut.' } };
    }
    state.methods = state.methods.filter(function (x) { return x.id !== id; });
    return { ok: true };
  }

  /* ---------- transactions ---------- */

  function saveTransaction(state, input) {
    const errors = {};
    const type = input.type;
    if (type !== 'income' && type !== 'expense') errors.type = 'Pilih pemasukan atau pengeluaran.';

    const amt = parseAmount(input.amount);
    if (!amt.ok) errors.amount = amt.error;

    const description = String(input.description || '').trim();
    if (!description) errors.description = 'Masukkan deskripsi.';
    else if (description.length > 100) errors.description = 'Deskripsi maksimal 100 karakter.';

    const cat = byId(state.categories, input.categoryId);
    if (!input.categoryId) errors.categoryId = 'Pilih kategori.';
    else if (!cat) errors.categoryId = 'Kategori ini sudah tidak ada.';
    else if (!errors.type && cat.type !== type) errors.categoryId = 'Pilih kategori ' + typeLabel(type).toLowerCase() + '.';

    if (!isValidDate(input.date)) errors.date = 'Masukkan tanggal yang valid.';

    if (!input.methodId) errors.methodId = 'Pilih metode pembayaran.';
    else if (!byId(state.methods, input.methodId)) errors.methodId = 'Metode pembayaran ini sudah tidak ada.';

    if (hasKeys(errors)) return { ok: false, errors: errors };

    const fields = { type: type, amount: amt.value, description: description, categoryId: input.categoryId, methodId: input.methodId, date: input.date };
    if (input.id) {
      const t = byId(state.transactions, input.id);
      if (!t) return { ok: false, errors: { _: 'Transaksi tidak ditemukan.' } };
      Object.assign(t, fields);
      return { ok: true, item: t };
    }
    const item = Object.assign({ id: uid(), createdAt: Date.now() }, fields);
    state.transactions.push(item);
    return { ok: true, item: item };
  }

  function deleteTransaction(state, id) {
    if (!byId(state.transactions, id)) return { ok: false, errors: { _: 'Transaksi tidak ditemukan.' } };
    state.transactions = state.transactions.filter(function (t) { return t.id !== id; });
    return { ok: true };
  }

  /* ---------- budgets ---------- */

  function saveBudget(state, input) {
    const errors = {};
    if (!isValidMonth(input.month)) return { ok: false, errors: { _: 'Bulan tidak valid.' } };
    const cat = byId(state.categories, input.categoryId);
    if (!input.categoryId) errors.categoryId = 'Pilih kategori pengeluaran.';
    else if (!cat) errors.categoryId = 'Kategori ini sudah tidak ada.';
    else if (cat.type !== 'expense') errors.categoryId = 'Anggaran hanya bisa memakai kategori pengeluaran.';

    const amt = parseAmount(input.amount);
    if (!amt.ok) errors.amount = amt.error;

    if (!errors.categoryId && state.budgets.some(function (b) {
      return b.id !== input.id && b.month === input.month && b.categoryId === input.categoryId;
    })) errors.categoryId = 'Kategori ini sudah punya anggaran untuk ' + monthLabel(input.month) + '.';

    const existing = input.id ? byId(state.budgets, input.id) : null;
    if (input.id && !existing) return { ok: false, errors: { _: 'Anggaran tidak ditemukan.' } };
    if (hasKeys(errors)) return { ok: false, errors: errors };

    if (existing) { existing.categoryId = input.categoryId; existing.amount = amt.value; return { ok: true, item: existing }; }
    const item = { id: uid(), month: input.month, categoryId: input.categoryId, amount: amt.value };
    state.budgets.push(item);
    return { ok: true, item: item };
  }

  function deleteBudget(state, id) {
    if (!byId(state.budgets, id)) return { ok: false, errors: { _: 'Anggaran tidak ditemukan.' } };
    state.budgets = state.budgets.filter(function (b) { return b.id !== id; });
    return { ok: true };
  }

  function copyableBudgets(state, fromMonth, toMonth) {
    return state.budgets.filter(function (b) {
      if (b.month !== fromMonth) return false;
      const cat = byId(state.categories, b.categoryId);
      if (!cat || cat.type !== 'expense') return false;
      return !state.budgets.some(function (x) { return x.month === toMonth && x.categoryId === b.categoryId; });
    });
  }

  function copyBudgets(state, fromMonth, toMonth) {
    const list = copyableBudgets(state, fromMonth, toMonth);
    list.forEach(function (b) {
      state.budgets.push({ id: uid(), month: toMonth, categoryId: b.categoryId, amount: b.amount });
    });
    return list.length;
  }

  /* ---------- financial targets ---------- */

  function saveTarget(state, input) {
    const errors = {};
    const name = String(input.name || '').trim();
    if (!name) errors.name = 'Masukkan nama target.';
    else if (name.length > 60) errors.name = 'Nama maksimal 60 karakter.';

    if (!input.categoryId) errors.categoryId = 'Pilih kategori.';
    else if (!byId(state.categories, input.categoryId)) errors.categoryId = 'Kategori ini sudah tidak ada.';

    const target = parseAmount(input.target);
    if (!target.ok) errors.target = target.error;

    const saved = parseAmount(input.saved, { allowEmpty: true, allowZero: true });
    if (!saved.ok) errors.saved = saved.error;

    const existing = input.id ? byId(state.targets, input.id) : null;
    if (input.id && !existing) return { ok: false, errors: { _: 'Target tidak ditemukan.' } };
    if (hasKeys(errors)) return { ok: false, errors: errors };

    const fields = { name: name, categoryId: input.categoryId, target: target.value, saved: saved.value };
    if (existing) { Object.assign(existing, fields); return { ok: true, item: existing }; }
    const item = Object.assign({ id: uid() }, fields);
    state.targets.push(item);
    return { ok: true, item: item };
  }

  function deleteTarget(state, id) {
    if (!byId(state.targets, id)) return { ok: false, errors: { _: 'Target tidak ditemukan.' } };
    state.targets = state.targets.filter(function (t) { return t.id !== id; });
    return { ok: true };
  }

  return {
    version: 5,
    emptyState: emptyState, isValidState: isValidState, uid: uid, byId: byId, typeLabel: typeLabel,
    todayISO: todayISO, monthKey: monthKey, currentMonthKey: currentMonthKey, isValidMonth: isValidMonth,
    isValidDate: isValidDate, shiftMonth: shiftMonth, monthLabel: monthLabel, formatDate: formatDate, formatDay: formatDay,
    parseAmount: parseAmount, formatIDR: formatIDR, formatPct: formatPct,
    filterTransactions: filterTransactions, summarize: summarize, totalSummary: totalSummary, diffState: diffState, spentFor: spentFor,
    budgetsForMonth: budgetsForMonth, budgetProgress: budgetProgress, targetProgress: targetProgress,
    categoryUsage: categoryUsage, describeCategoryUsage: describeCategoryUsage, methodUsage: methodUsage,
    saveCategory: saveCategory, deleteCategory: deleteCategory,
    saveMethod: saveMethod, deleteMethod: deleteMethod,
    saveTransaction: saveTransaction, deleteTransaction: deleteTransaction,
    saveBudget: saveBudget, deleteBudget: deleteBudget, copyableBudgets: copyableBudgets, copyBudgets: copyBudgets,
    saveTarget: saveTarget, deleteTarget: deleteTarget
  };
});
