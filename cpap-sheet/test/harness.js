'use strict';
/**
 * Code.gs をモック環境に読み込むための道具。
 *   const t = load({ now: '2026-10-01T10:00:00+09:00', sheetTz: 'Asia/Tokyo' });
 *   t.gs.setup();  t.typeIn('患者一覧', 'B2', '山田 太郎');
 * スクリプトのタイムゾーン = このプロセスのタイムゾーン（process.env.TZ）です。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnv } = require('./gas-mock');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function fakeDateClass(fixedMs) {
  const Real = Date;
  function FakeDate(...args) {
    if (!new.target) return new Real(fixedMs).toString();
    return args.length ? new Real(...args) : new Real(fixedMs);
  }
  FakeDate.prototype = Real.prototype;
  FakeDate.UTC = Real.UTC;
  FakeDate.parse = Real.parse;
  FakeDate.now = () => fixedMs;
  return FakeDate;
}

function load(opts) {
  opts = opts || {};
  const scriptTz = process.env.TZ || 'Asia/Tokyo';
  const nowMs = new Date(opts.now || '2026-10-01T10:00:00+09:00').getTime();
  const env = createEnv({ scriptTz, sheetTz: opts.sheetTz || scriptTz, nowMs });
  const sandbox = Object.assign({}, env.globals, { Date: fakeDateClass(nowMs) });
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  const ss = env.state.ss;
  ss.insertSheet('シート1');

  const sheet = name => {
    const sh = ss.getSheetByName(name);
    if (!sh) throw new Error('シートがありません: ' + name);
    return sh;
  };

  /** 本物のスプレッドシートが入力をどう解釈するかをまねて書き込み、onEdit を呼ぶ */
  function parseLikeSheets(text) {
    if (text === '' || text === null) return '';
    if (typeof text !== 'string') return text;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    let m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(text);
    if (m) return env.internals.instantFor(+m[1], +m[2], +m[3], 0, 0, 0, ss._tz);
    m = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
    if (m) {
      const y = env.internals.tzParts(new Date(nowMs), ss._tz).y;
      return env.internals.instantFor(y, +m[1], +m[2], 0, 0, 0, ss._tz);
    }
    return text;
  }
  function typeIn(name, a1, text) {
    const range = sheet(name).getRange(a1);
    range.setValue(parseLikeSheets(text));
    ctx.onEdit({ range, value: text });
    return range;
  }
  /** 画面で貼り付けたときと同じく、足りない行は自動で増やす */
  function grow(name, lastRow) {
    const sh = sheet(name);
    if (sh.getMaxRows() < lastRow) sh.insertRowsAfter(sh.getMaxRows(), lastRow - sh.getMaxRows());
  }
  function paste(name, row, col, rows) {
    grow(name, row + rows.length - 1);
    const range = sheet(name).getRange(row, col, rows.length, rows[0].length);
    range.setValues(rows.map(r => r.map(parseLikeSheets)));
    ctx.onEdit({ range });
    return range;
  }
  function select(name, a1s) {
    const sh = sheet(name);
    ss.setActiveSheet(sh);
    ss._activeRanges = a1s.map(a => sh.getRange(a));
  }
  /** シートの値（表示用の文字）を2次元配列で */
  function display(name, a1) {
    return sheet(name).getRange(a1).getDisplayValues();
  }
  function values(name, a1) {
    return sheet(name).getRange(a1).getValues();
  }
  /** シートの中から文字を探して [行, 列] を返す */
  function find(name, text) {
    const sh = sheet(name);
    for (const [k, cell] of sh._cells) {
      if (cell.v === text) return k.split(',').map(Number);
    }
    return null;
  }
  function lastToast() { const t = ss._toasts; return t.length ? t[t.length - 1].msg : ''; }
  function ymdOf(v) {
    if (!(v instanceof Date)) return v;
    const p = env.internals.tzParts(v, ss._tz);
    return `${p.y}/${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}`;
  }
  /** スプレッドシートのタイムゾーンで、その日の0時ちょうどか */
  function isMidnight(v) {
    const p = env.internals.tzParts(v, ss._tz);
    return p.H === 0 && p.M === 0 && p.S === 0;
  }
  function cellDate(y, m, d) { return env.internals.instantFor(y, m, d, 0, 0, 0, ss._tz); }

  return { env, state: env.state, ss, gs: ctx, sheet, typeIn, paste, grow, select, display, values, find, lastToast, ymdOf,
           isMidnight, cellDate, nowMs };
}

module.exports = { load };
