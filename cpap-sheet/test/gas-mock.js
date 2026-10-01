'use strict';
/**
 * Google Apps Script（スプレッドシート）の最小限のモック。
 * Code.gs が使う API だけを実装し、本物と同じ条件でエラーを出す：
 *   ・setValues の行数・列数の不一致、0行の範囲、シートの外の範囲
 *   ・結合セルの一部だけを結合／固定（freeze）しようとしたとき
 *   ・同じ名前のシート、空のドロップダウン、すでにあるフィルタ
 *   ・未実装のメソッド（＝本物にないかもしれないメソッド）を呼んだとき
 * 日付はスプレッドシートのタイムゾーンでの「シリアル値」で保存し、
 * スクリプトとスプレッドシートのタイムゾーンが違うときのずれも再現する。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function strict(obj, label) {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || ['then', 'toJSON', 'inspect', 'constructor', 'nodeType'].includes(prop)) return undefined;
      throw new Error(`[mock] ${label}.${String(prop)} は未実装です`);
    }
  });
}

// ---------- 日付とタイムゾーン ----------
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
const partsFmt = {};
function tzParts(date, tz) {
  if (!partsFmt[tz]) {
    partsFmt[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23'
    });
  }
  const o = {};
  partsFmt[tz].formatToParts(date).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour, M: +o.minute, S: +o.second };
}
function instantFor(y, m, d, H, M, S, tz) {
  const want = Date.UTC(y, m - 1, d, H, M, S);
  let guess = want;
  for (let i = 0; i < 4; i++) {
    const p = tzParts(new Date(guess), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - want;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}
function dateToSerial(date, tz) {
  const p = tzParts(date, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - SERIAL_EPOCH) / 86400000;
}
function serialToDate(serial, tz) {
  const u = new Date(SERIAL_EPOCH + Math.round(serial * 86400000));
  return instantFor(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(),
    u.getUTCSeconds(), tz);
}
function formatDate(date, tz, pattern) {
  const p = tzParts(date, tz);
  const pad = (n, w) => String(n).padStart(w, '0');
  return pattern.replace(/yyyy|MM|M|dd|d|HH|H|mm|ss/g, t => ({
    yyyy: pad(p.y, 4), MM: pad(p.m, 2), M: String(p.m), dd: pad(p.d, 2), d: String(p.d),
    HH: pad(p.H, 2), H: String(p.H), mm: pad(p.M, 2), ss: pad(p.S, 2)
  })[t]);
}
function parseDate(s, tz, pattern) {
  if (pattern !== 'yyyy-M-d') throw new Error('[mock] parseDate: 未対応の形式 ' + pattern);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) throw new Error('[mock] parseDate: 読めない日付 ' + s);
  return instantFor(+m[1], +m[2], +m[3], 0, 0, 0, tz);
}

// ---------- A1 ----------
function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); } return s; }
function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!m) throw new Error('[mock] A1表記が読めません: ' + a1);
  const r1 = +m[2], c1 = colToNum(m[1]);
  const r2 = m[3] ? +m[4] : r1, c2 = m[3] ? colToNum(m[3]) : c1;
  return [Math.min(r1, r2), Math.min(c1, c2), Math.abs(r2 - r1) + 1, Math.abs(c2 - c1) + 1];
}

// ---------- 表示形式 ----------
function formatNumber(v, fmt) {
  if (!fmt || fmt === 'General') return String(v);
  const sections = [];
  let cur = '', q = false;
  for (const ch of fmt) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) { sections.push(cur); cur = ''; } else cur += ch;
  }
  sections.push(cur);
  let sec = sections[0], val = v;
  if (v < 0 && sections.length > 1) { sec = sections[1]; val = -v; }
  if (v === 0 && sections.length > 2) sec = sections[2];
  let lit = '', core = '', inQ = false;
  const pieces = [];
  for (const ch of sec) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (inQ) { pieces.push({ t: 'lit', s: ch }); continue; }
    if ('#0,.%'.includes(ch)) pieces.push({ t: 'num', s: ch }); else pieces.push({ t: 'lit', s: ch });
  }
  const numPart = pieces.filter(p => p.t === 'num').map(p => p.s).join('');
  if (!numPart) return pieces.map(p => p.s).join('');
  const pct = numPart.includes('%');
  if (pct) val *= 100;
  const dec = (numPart.split('.')[1] || '').replace(/[^0]/g, '').length;
  let s = Math.abs(val).toFixed(dec);
  if (numPart.includes(',')) { const [a, b] = s.split('.'); s = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : ''); }
  if (val < 0 && sections.length === 1) s = '-' + s;
  let out = '', placed = false;
  for (const p of pieces) {
    if (p.t === 'num') { if (!placed) { out += s + (pct ? '%' : ''); placed = true; } }
    else out += p.s;
  }
  return out;
}

// ---------- 範囲 ----------
class Range {
  constructor(sheet, r, c, nr, nc) {
    if (nr < 1) throw new Error('The number of rows in the range must be at least 1.');
    if (nc < 1) throw new Error('The number of columns in the range must be at least 1.');
    if (r < 1 || c < 1 || r + nr - 1 > sheet._maxRows || c + nc - 1 > sheet._maxCols) {
      throw new Error(`The coordinates of the range are outside the dimensions of the sheet. (${sheet._name} r${r} c${c} ${nr}x${nc}; max ${sheet._maxRows}x${sheet._maxCols})`);
    }
    this._s = sheet; this._r = r; this._c = c; this._nr = nr; this._nc = nc;
  }
  _each(fn) { for (let i = 0; i < this._nr; i++) for (let j = 0; j < this._nc; j++) fn(this._r + i, this._c + j, i, j); }
  _cell(r, c, create) { return this._s._cell(r, c, create); }
  _style(key, value) { this._each((r, c) => { this._cell(r, c, true)[key] = value; }); return this; }
  _check2d(values, what) {
    if (!Array.isArray(values)) throw new Error(`${what}: 2次元配列ではありません`);
    if (values.length !== this._nr) throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values.length} but the range has ${this._nr}.`);
    values.forEach(row => {
      if (!Array.isArray(row) || row.length !== this._nc) throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${Array.isArray(row) ? row.length : '?'} but the range has ${this._nc}.`);
    });
  }
  getSheet() { return this._s._proxy; }
  getRow() { return this._r; }
  getColumn() { return this._c; }
  getNumRows() { return this._nr; }
  getNumColumns() { return this._nc; }
  getLastRow() { return this._r + this._nr - 1; }
  getLastColumn() { return this._c + this._nc - 1; }
  getA1Notation() {
    const a = numToCol(this._c) + this._r;
    return this._nr === 1 && this._nc === 1 ? a : a + ':' + numToCol(this._c + this._nc - 1) + (this._r + this._nr - 1);
  }
  getCell(i, j) { return this._s._range(this._r + i - 1, this._c + j - 1, 1, 1); }
  getValues() {
    const out = [];
    for (let i = 0; i < this._nr; i++) {
      const row = [];
      for (let j = 0; j < this._nc; j++) row.push(this._s._getValue(this._r + i, this._c + j));
      out.push(row);
    }
    return out;
  }
  getValue() { return this._s._getValue(this._r, this._c); }
  getDisplayValues() {
    return this.getValues().map((row, i) => row.map((v, j) => this._s._display(this._r + i, this._c + j, v)));
  }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  getFormula() { const cell = this._cell(this._r, this._c); return cell && cell.f ? cell.f : ''; }
  getFormulas() {
    const out = [];
    for (let i = 0; i < this._nr; i++) {
      const row = [];
      for (let j = 0; j < this._nc; j++) { const cell = this._cell(this._r + i, this._c + j); row.push(cell && cell.f ? cell.f : ''); }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    this._check2d(values, 'setValues');
    this._each((r, c, i, j) => this._s._setValue(r, c, values[i][j]));
    return this;
  }
  setValue(v) { this._each((r, c) => this._s._setValue(r, c, v)); return this; }
  setFormula(f) { this._each((r, c) => this._s._setValue(r, c, f)); return this; }
  setFormulas(fs2) {
    this._check2d(fs2, 'setFormulas');
    this._each((r, c, i, j) => this._s._setValue(r, c, fs2[i][j]));
    return this;
  }
  setRichTextValue(rt) {
    if (!rt || !rt._rich) throw new Error('[mock] setRichTextValue: RichTextValue ではありません');
    this._each((r, c) => { this._s._setValue(r, c, rt._text); this._cell(r, c, true).rich = rt; });
    return this;
  }
  clearContent() { this._each((r, c) => { const cell = this._cell(r, c); if (cell) { delete cell.v; delete cell.f; delete cell.rich; } }); return this; }
  clearDataValidations() { this._each((r, c) => { const cell = this._cell(r, c); if (cell) delete cell.dv; }); return this; }
  clearNote() { this._each((r, c) => { const cell = this._cell(r, c); if (cell) delete cell.note; }); return this; }
  setNote(n) { return this._style('note', n); }
  getNote() { const cell = this._cell(this._r, this._c); return cell && cell.note ? cell.note : ''; }
  setDataValidation(rule) {
    if (rule !== null && !(rule && rule._dv)) throw new Error('[mock] setDataValidation: ルールではありません');
    return this._style('dv', rule);
  }
  getDataValidation() { const cell = this._cell(this._r, this._c); return cell && cell.dv ? cell.dv : null; }
  setNumberFormat(f) { return this._style('fmt', f); }
  setBackground(c) { return this._style('bg', c); }
  setBackgrounds(arr) {
    this._check2d(arr, 'setBackgrounds');
    this._each((r, c, i, j) => { this._cell(r, c, true).bg = arr[i][j]; });
    return this;
  }
  setFontColor(c) { return this._style('fc', c); }
  setFontWeight(w) { return this._style('fw', w); }
  setFontSize(s) { return this._style('fs', s); }
  setFontStyle(s) { return this._style('fst', s); }
  setHorizontalAlignment(a) { return this._style('ha', a); }
  setVerticalAlignment(a) { return this._style('va', a); }
  setWrap(w) { return this._style('wrap', w); }
  setBorder(top, left, bottom, right, vertical, horizontal, color, style) {
    if (arguments.length !== 6 && arguments.length !== 8) throw new Error('[mock] setBorder: 引数は6個か8個');
    this._s._borders.push({ r: this._r, c: this._c, nr: this._nr, nc: this._nc, top, left, bottom, right, vertical, horizontal, color });
    return this;
  }
  merge() {
    const s = this._s;
    if (this._nr === 1 && this._nc === 1) return this;
    const r2 = this._r + this._nr - 1, c2 = this._c + this._nc - 1;
    if ((s._frozenRows && this._r <= s._frozenRows && r2 > s._frozenRows) ||
        (s._frozenCols && this._c <= s._frozenCols && c2 > s._frozenCols)) {
      throw new Error("You can't merge frozen and non-frozen rows/columns.");
    }
    const keep = [];
    for (const m of s._merges) {
      const overlap = !(m.r2 < this._r || m.r1 > r2 || m.c2 < this._c || m.c1 > c2);
      if (!overlap) { keep.push(m); continue; }
      const inside = m.r1 >= this._r && m.r2 <= r2 && m.c1 >= this._c && m.c2 <= c2;
      if (!inside) throw new Error('You must select all cells in a merged range to merge or unmerge them.');
    }
    keep.push({ r1: this._r, c1: this._c, r2, c2 });
    s._merges = keep;
    return this;
  }
  breakApart() {
    const r2 = this._r + this._nr - 1, c2 = this._c + this._nc - 1;
    const s = this._s;
    for (const m of s._merges) {
      const overlap = !(m.r2 < this._r || m.r1 > r2 || m.c2 < this._c || m.c1 > c2);
      const inside = m.r1 >= this._r && m.r2 <= r2 && m.c1 >= this._c && m.c2 <= c2;
      if (overlap && !inside) throw new Error('You must select all cells in a merged range to merge or unmerge them.');
    }
    s._merges = s._merges.filter(m => !(m.r1 >= this._r && m.r2 <= r2 && m.c1 >= this._c && m.c2 <= c2));
    return this;
  }
  createFilter() {
    if (this._s._filter) throw new Error("You can't create a filter in a sheet that already has a filter.");
    const f = { _range: this };
    f.getRange = () => this;
    f.remove = () => { this._s._filter = null; };
    this._s._filter = strict(f, 'Filter');
    return this._s._filter;
  }
  protect() { return this._s._addProtection('RANGE', this); }
}

// ---------- シート ----------
class Sheet {
  constructor(ss, name, id) {
    this._ss = ss; this._name = name; this._id = id;
    this._maxRows = 1000; this._maxCols = 26;
    this._cells = new Map();
    this._merges = []; this._borders = []; this._charts = []; this._cf = []; this._protections = [];
    this._bandings = []; this._metadata = []; this._filter = null; this._frozenRows = 0; this._frozenCols = 0;
    this._hiddenCols = new Set(); this._hiddenByFilter = new Set(); this._hidden = false;
    this._colWidths = {}; this._rowHeights = {}; this._tabColor = null; this._gridlinesHidden = false;
    this._proxy = strict(this, 'Sheet');
  }
  _key(r, c) { return r + ',' + c; }
  _cell(r, c, create) {
    const k = this._key(r, c);
    let cell = this._cells.get(k);
    if (!cell && create) { cell = {}; this._cells.set(k, cell); }
    return cell;
  }
  _setValue(r, c, v) {
    if (v === undefined) throw new Error(`[mock] undefined を書き込もうとしました（${this._name} r${r} c${c}）`);
    const cell = this._cell(r, c, true);
    delete cell.f; delete cell.rich;
    if (v === null || v === '') { delete cell.v; return; }
    if (v instanceof Date) {
      if (isNaN(v.getTime())) throw new Error('[mock] 無効な日付');
      cell.v = { __date: dateToSerial(v, this._ss._tz) };
      if (!cell.fmt) cell.fmt = 'yyyy/mm/dd';
      return;
    }
    if (typeof v === 'string' && v.charAt(0) === '=') { cell.f = v; delete cell.v; return; }
    if (typeof v === 'object') throw new Error('[mock] オブジェクトは書き込めません: ' + JSON.stringify(v));
    cell.v = v;
  }
  _getValue(r, c) {
    const cell = this._cell(r, c);
    if (!cell) return '';
    if (cell.f) return cell.cached !== undefined ? cell.cached : '';
    if (cell.v === undefined) return '';
    if (cell.v && typeof cell.v === 'object' && '__date' in cell.v) return serialToDate(cell.v.__date, this._ss._tz);
    return cell.v;
  }
  _display(r, c, v) {
    if (v === '' || v === null) return '';
    const cell = this._cell(r, c) || {};
    if (v instanceof Date) return formatDate(v, this._ss._tz, 'yyyy/MM/dd');
    if (typeof v === 'number') return formatNumber(v, cell.fmt);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  _range(r, c, nr, nc) { return strict(new Range(this, r, c, nr, nc), 'Range'); }
  _addProtection(type, range) {
    const p = {
      _type: type, _range: range, _desc: '', _warn: false, _unprotected: [],
      setDescription(d) { this._desc = d; return proxy; },
      getDescription() { return this._desc; },
      setWarningOnly(b) { this._warn = b; return proxy; },
      isWarningOnly() { return this._warn; },
      setUnprotectedRanges(rs) {
        if (this._type !== 'SHEET') throw new Error('[mock] setUnprotectedRanges はシートの保護だけ');
        this._unprotected = rs; return proxy;
      },
      getRange() { return this._range; },
      remove: () => { this._protections = this._protections.filter(x => x !== proxy); }
    };
    const proxy = strict(p, 'Protection');
    this._protections.push(proxy);
    return proxy;
  }
  _checkFreeze(rows, cols) {
    for (const m of this._merges) {
      if (rows !== null && rows > 0 && m.r1 <= rows && m.r2 > rows) throw new Error('Sorry, it is not possible to freeze rows that contain only part of a merged cell.');
      if (cols !== null && cols > 0 && m.c1 <= cols && m.c2 > cols) throw new Error('Sorry, it is not possible to freeze columns that contain only part of a merged cell.');
    }
  }

  getName() { return this._name; }
  setName(n) {
    if (this._ss._sheets.some(s => s !== this && s._name === n)) throw new Error(`A sheet with the name "${n}" already exists. Please enter another name.`);
    this._name = n; return this._proxy;
  }
  getSheetId() { return this._id; }
  getParent() { return this._ss._proxy; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const [r, cc, nr, nc] = parseA1(a); return this._range(r, cc, nr, nc); }
    return this._range(a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getDataRange() { return this._range(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getLastRow() {
    let last = 0;
    for (const [k, cell] of this._cells) if (cell.v !== undefined || cell.f) last = Math.max(last, +k.split(',')[0]);
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const [k, cell] of this._cells) if (cell.v !== undefined || cell.f) last = Math.max(last, +k.split(',')[1]);
    return last;
  }
  getMaxRows() { return this._maxRows; }
  getMaxColumns() { return this._maxCols; }
  insertRowsAfter(after, n) {
    if (after < 1 || after > this._maxRows || n < 1) throw new Error('[mock] insertRowsAfter の引数が不正');
    const moved = new Map();
    for (const [k, cell] of this._cells) { const [r, c] = k.split(',').map(Number); moved.set(this._key(r > after ? r + n : r, c), cell); }
    this._cells = moved; this._maxRows += n; return this._proxy;
  }
  insertColumnAfter(after) { return this.insertColumnsAfter(after, 1); }
  insertColumnsAfter(after, n) {
    if (after < 1 || after > this._maxCols || n < 1) throw new Error('[mock] insertColumnsAfter の引数が不正');
    const moved = new Map();
    for (const [k, cell] of this._cells) { const [r, c] = k.split(',').map(Number); moved.set(this._key(r, c > after ? c + n : c), cell); }
    this._cells = moved; this._maxCols += n; return this._proxy;
  }
  clear() {
    for (const cell of this._cells.values()) {
      delete cell.v; delete cell.f; delete cell.rich; delete cell.cached;
      ['fmt', 'bg', 'fc', 'fw', 'fs', 'fst', 'ha', 'va', 'wrap'].forEach(k => delete cell[k]);
    }
    this._borders = [];
    return this._proxy;
  }
  clearConditionalFormatRules() { this._cf = []; }
  setConditionalFormatRules(rules) {
    rules.forEach(r => {
      if (!r || !r._cf) throw new Error('[mock] 条件付き書式のルールではありません');
      if (!r.ranges || !r.ranges.length) throw new Error('[mock] 条件付き書式に範囲がありません');
      r.ranges.forEach(rg => { if (rg._s !== this) throw new Error('[mock] 条件付き書式の範囲が別のシート'); });
    });
    this._cf = rules.slice();
  }
  getConditionalFormatRules() { return this._cf.slice(); }
  getCharts() { return this._charts.slice(); }
  removeChart(ch) { this._charts = this._charts.filter(x => x !== ch); }
  newChart() { return strict(new ChartBuilder(this), 'EmbeddedChartBuilder'); }
  insertChart(ch) {
    if (!ch || !ch._chart) throw new Error('[mock] insertChart: グラフではありません');
    if (ch.pos.r > this._maxRows || ch.pos.c > this._maxCols) throw new Error('[mock] グラフの位置がシートの外です');
    ch.ranges.forEach(rg => { if (rg._s !== this) throw new Error('[mock] グラフの範囲が別のシート'); });
    this._charts.push(ch);
  }
  setFrozenRows(n) { this._checkFreeze(n, null); this._frozenRows = n; }
  setFrozenColumns(n) { this._checkFreeze(null, n); this._frozenCols = n; }
  getFrozenRows() { return this._frozenRows; }
  getFrozenColumns() { return this._frozenCols; }
  setColumnWidth(c, w) { if (c < 1 || c > this._maxCols) throw new Error('[mock] setColumnWidth: 列がシートの外'); this._colWidths[c] = w; return this._proxy; }
  setRowHeight(r, h) { if (r < 1 || r > this._maxRows) throw new Error('[mock] setRowHeight: 行がシートの外'); this._rowHeights[r] = h; return this._proxy; }
  setRowHeights(r, n, h) { for (let i = 0; i < n; i++) this.setRowHeight(r + i, h); return this._proxy; }
  hideColumns(c, n) { for (let i = 0; i < (n || 1); i++) { if (c + i > this._maxCols) throw new Error('[mock] hideColumns: 列がシートの外'); this._hiddenCols.add(c + i); } }
  showColumns(c, n) { for (let i = 0; i < (n || 1); i++) this._hiddenCols.delete(c + i); }
  hideSheet() {
    if (this._ss._sheets.filter(s => !s._hidden && s !== this).length === 0) throw new Error("You can't hide all the sheets in a document.");
    this._hidden = true; return this._proxy;
  }
  showSheet() { this._hidden = false; return this._proxy; }
  isSheetHidden() { return this._hidden; }
  setTabColor(c) { this._tabColor = c; return this._proxy; }
  setHiddenGridlines(b) { this._gridlinesHidden = b; return this._proxy; }
  getDeveloperMetadata() {
    return this._metadata.map(md => strict({
      getKey: () => md.key, getValue: () => md.value,
      getLocation: () => strict({ getLocationType: () => 'SHEET', getSheet: () => this._proxy }, 'DeveloperMetadataLocation')
    }, 'DeveloperMetadata'));
  }
  addDeveloperMetadata(key, value) { this._metadata.push({ key, value }); return this._proxy; }
  protect() { return this._addProtection('SHEET', null); }
  getProtections(type) { return this._protections.filter(p => p._type === type); }
  getFilter() { return this._filter; }
  isRowHiddenByFilter(r) { return this._hiddenByFilter.has(r); }
  getBandings() { return this._bandings.slice(); }
}

class ChartBuilder {
  constructor(sheet) {
    this._sheet = sheet; this.type = 'column'; this.ranges = []; this.options = {}; this.pos = null;
    this.numHeaders = -1; this.hiddenStrategy = null; this.reversed = false;
  }
  asColumnChart() { this.type = 'column'; return strict(this, 'EmbeddedColumnChartBuilder'); }
  asLineChart() { this.type = 'line'; return strict(this, 'EmbeddedLineChartBuilder'); }
  asPieChart() { this.type = 'pie'; return strict(this, 'EmbeddedPieChartBuilder'); }
  addRange(r) { if (!(r instanceof Range) && !(r && r._s)) throw new Error('[mock] addRange: 範囲ではありません'); this.ranges.push(r); return this; }
  setNumHeaders(n) { this.numHeaders = n; return this; }
  setPosition(r, c, ox, oy) { this.pos = { r, c, ox, oy }; return this; }
  setOption(k, v) { this.options[k] = v; return this; }
  setHiddenDimensionStrategy(s) { if (!s) throw new Error('[mock] setHiddenDimensionStrategy: 値がありません'); this.hiddenStrategy = s; return this; }
  reverseCategories() { if (this.type === 'pie') throw new Error('[mock] 円グラフに reverseCategories はありません'); this.reversed = true; return this; }
  build() {
    if (!this.pos) throw new Error('[mock] グラフの位置（setPosition）がありません');
    if (!this.ranges.length) throw new Error('[mock] グラフにデータ範囲がありません');
    return { _chart: true, type: this.type, ranges: this.ranges.slice(), options: Object.assign({}, this.options), pos: this.pos,
             reversed: this.reversed, hiddenStrategy: this.hiddenStrategy };
  }
}

// ---------- スプレッドシート ----------
class Spreadsheet {
  constructor(env, tz) {
    this._env = env; this._tz = tz; this._sheets = []; this._nextId = 1000; this._active = null;
    this._activeRanges = null; this._toasts = [];
    this._proxy = strict(this, 'Spreadsheet');
  }
  getId() { return 'mock-spreadsheet'; }
  getSpreadsheetTimeZone() { return this._tz; }
  getSheetByName(n) { const s = this._sheets.find(x => x._name === n); return s ? s._proxy : null; }
  getSheets() { return this._sheets.map(s => s._proxy); }
  insertSheet(name, index) {
    if (name === undefined) name = 'シート' + (this._sheets.length + 1);
    if (this._sheets.some(s => s._name === name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const s = new Sheet(this, name, this._nextId++);
    if (index === undefined) this._sheets.push(s); else this._sheets.splice(index, 0, s);
    this._active = s;
    return s._proxy;
  }
  deleteSheet(sh) { const s = this._unwrap(sh); this._sheets = this._sheets.filter(x => x !== s); if (this._active === s) this._active = this._sheets[0]; }
  _unwrap(sh) { const s = this._sheets.find(x => x._proxy === sh || x === sh); if (!s) throw new Error('[mock] シートが見つかりません'); return s; }
  setActiveSheet(sh) { this._active = this._unwrap(sh); return sh; }
  getActiveSheet() { return (this._active || this._sheets[0])._proxy; }
  moveActiveSheet(pos) {
    const s = this._active;
    if (pos < 1 || pos > this._sheets.length) throw new Error('[mock] moveActiveSheet: 位置が不正 ' + pos);
    this._sheets = this._sheets.filter(x => x !== s);
    this._sheets.splice(pos - 1, 0, s);
  }
  getActiveRange() { return this._activeRanges ? this._activeRanges[0] : null; }
  getActiveRangeList() {
    if (!this._activeRanges) return null;
    return strict({ getRanges: () => this._activeRanges.slice() }, 'RangeList');
  }
  toast(msg, title, sec) { this._toasts.push({ msg: String(msg), title }); }
  createDeveloperMetadataFinder() {
    const q = {};
    const finder = {
      withKey: k => { q.key = k; return proxy; },
      withValue: v => { q.value = v; return proxy; },
      find: () => {
        const out = [];
        this._sheets.forEach(s => s._metadata.forEach(md => {
          if ((q.key === undefined || md.key === q.key) && (q.value === undefined || md.value === q.value)) {
            out.push(strict({
              getKey: () => md.key, getValue: () => md.value,
              getLocation: () => strict({ getLocationType: () => 'SHEET', getSheet: () => s._proxy }, 'DeveloperMetadataLocation')
            }, 'DeveloperMetadata'));
          }
        }));
        return out;
      }
    };
    const proxy = strict(finder, 'DeveloperMetadataFinder');
    return proxy;
  }
}

// ---------- 環境（グローバル一式） ----------
function createEnv(opts) {
  opts = opts || {};
  const scriptTz = opts.scriptTz || 'Asia/Tokyo';
  const ss = new Spreadsheet(null, opts.sheetTz || scriptTz);
  const state = {
    ss, alerts: [], responses: [], sidebars: [], menus: [], triggers: [], props: {},
    locks: { script: false, document: false }, now: opts.now || null
  };

  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
  const ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' };
  const ui = strict({
    Button, ButtonSet,
    alert(a, b, c) {
      let title = '', prompt = a, buttons = ButtonSet.OK;
      if (arguments.length === 2) { prompt = a; buttons = b; }
      if (arguments.length === 3) { title = a; prompt = b; buttons = c; }
      state.alerts.push({ title, prompt, buttons });
      if (state.responses.length) return state.responses.shift();
      return buttons === ButtonSet.YES_NO || buttons === ButtonSet.YES_NO_CANCEL ? Button.YES : Button.OK;
    },
    createMenu(name) {
      const items = [];
      const menu = strict({
        addItem(caption, fn) { items.push({ caption, fn }); return menu; },
        addSeparator() { items.push({ sep: true }); return menu; },
        addSubMenu(sub) { items.push({ sub }); return menu; },
        addToUi() { state.menus.push({ name, items }); },
        _items: items, _name: name
      }, 'Menu');
      return menu;
    },
    showSidebar(html) { state.sidebars.push(html); }
  }, 'Ui');

  const newDV = () => {
    const b = {
      _crit: null, _allow: true, _help: '',
      requireValueInList(list, show) {
        if (!Array.isArray(list) || !list.length) throw new Error('[mock] requireValueInList: 候補が空です');
        if (list.length > 500) throw new Error('[mock] requireValueInList: 候補が500を超えています');
        b._crit = { type: 'list', list: list.slice() }; return proxy;
      },
      requireDate() { b._crit = { type: 'date' }; return proxy; },
      setAllowInvalid(v) { b._allow = v; return proxy; },
      setHelpText(t) { b._help = t; return proxy; },
      build() { if (!b._crit) throw new Error('[mock] 入力規則の条件がありません'); return { _dv: true, crit: b._crit, allowInvalid: b._allow, help: b._help }; }
    };
    const proxy = strict(b, 'DataValidationBuilder');
    return proxy;
  };
  const newCF = () => {
    const r = { _cf: true, ranges: null };
    const b = {
      whenFormulaSatisfied(f) { if (!/^=/.test(f)) throw new Error('[mock] 条件の式は = で始めてください'); r.formula = f; return proxy; },
      setBackground(c) { r.bg = c; return proxy; },
      setFontColor(c) { r.fc = c; return proxy; },
      setBold(v) { r.bold = v; return proxy; },
      setItalic(v) { r.italic = v; return proxy; },
      setRanges(rs) { r.ranges = rs.map(x => (x && x._s) ? x : null); if (r.ranges.some(x => !x)) throw new Error('[mock] setRanges: 範囲ではありません'); return proxy; },
      build() { return Object.assign({}, r); }
    };
    const proxy = strict(b, 'ConditionalFormatRuleBuilder');
    return proxy;
  };
  const newRich = () => {
    const v = { _rich: true, _text: '', _links: [] };
    const b = {
      setText(t) { v._text = t; return proxy; },
      setLinkUrl(s, e, url) {
        if (s < 0 || e > v._text.length || s >= e) throw new Error(`[mock] setLinkUrl: 位置が不正 ${s}-${e} / ${v._text.length}`);
        v._links.push({ s, e, url }); return proxy;
      },
      build() { return strict(Object.assign(v, { getText: () => v._text }), 'RichTextValue'); }
    };
    const proxy = strict(b, 'RichTextValueBuilder');
    return proxy;
  };

  const SpreadsheetApp = strict({
    getActiveSpreadsheet: () => ss._proxy,
    getUi: () => ui,
    flush: () => {},
    newDataValidation: newDV,
    newConditionalFormatRule: newCF,
    newRichTextValue: newRich,
    BorderStyle: { SOLID: 'SOLID', DOTTED: 'DOTTED', DASHED: 'DASHED', SOLID_MEDIUM: 'SOLID_MEDIUM' },
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    DeveloperMetadataLocationType: { SHEET: 'SHEET', SPREADSHEET: 'SPREADSHEET', ROW: 'ROW', COLUMN: 'COLUMN' },
    BandingTheme: { BLUE: 'BLUE', LIGHT_GREY: 'LIGHT_GREY' }
  }, 'SpreadsheetApp');

  const lock = kind => strict({
    tryLock: () => { if (state.locks[kind]) return false; state.locks[kind] = true; return true; },
    waitLock: () => { if (state.locks[kind]) throw new Error('Lock timeout'); state.locks[kind] = true; },
    releaseLock: () => { state.locks[kind] = false; },
    hasLock: () => state.locks[kind]
  }, 'Lock');

  const props = strict({
    getProperty: k => (k in state.props ? state.props[k] : null),
    setProperty: (k, v) => { state.props[k] = String(v); return props; },
    setProperties: o => { Object.keys(o).forEach(k => { state.props[k] = String(o[k]); }); return props; },
    deleteProperty: k => { delete state.props[k]; return props; },
    getProperties: () => Object.assign({}, state.props)
  }, 'Properties');

  const ScriptApp = strict({
    newTrigger(fn) {
      const t = { fn, type: null, minutes: null };
      const tb = strict({
        everyMinutes(n) { if (![1, 5, 10, 15, 30].includes(n)) throw new Error('[mock] everyMinutes は 1,5,10,15,30 のみ'); t.minutes = n; return tb; },
        everyHours(n) { t.hours = n; return tb; },
        atHour(h) { t.hour = h; return tb; },
        everyDays(n) { t.days = n; return tb; },
        create() {
          const trig = strict({ getHandlerFunction: () => fn, getUniqueId: () => 'trig' + state.triggers.length, _t: t }, 'Trigger');
          state.triggers.push(trig); return trig;
        }
      }, 'ClockTriggerBuilder');
      return strict({ timeBased() { t.type = 'time'; return tb; } }, 'TriggerBuilder');
    },
    getProjectTriggers: () => state.triggers.slice(),
    deleteTrigger: t => { state.triggers = state.triggers.filter(x => x !== t); }
  }, 'ScriptApp');

  const Utilities = strict({
    formatDate: (d, tz, p) => { if (!(d instanceof Date)) throw new Error('[mock] formatDate: Date ではありません'); return formatDate(d, tz, p); },
    parseDate: (s, tz, p) => parseDate(s, tz, p),
    computeDigest: (alg, s, cs) => {
      if (alg !== 'MD5') throw new Error('[mock] MD5 のみ');
      return Array.from(crypto.createHash('md5').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
    },
    base64Encode: bytes => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))).toString('base64'),
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  }, 'Utilities');

  const HtmlService = strict({
    createTemplateFromFile(name) {
      const file = path.join(__dirname, '..', name + '.html');
      const src = fs.readFileSync(file, 'utf8');
      const t = {
        evaluate() {
          const html = src.replace(/<\?=\s*(\w+)\s*\?>/g, (m, k) => String(t[k] === undefined ? '' : t[k])
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));
          const out = { _html: html, _title: '', setTitle(x) { out._title = x; return out; }, getContent: () => html };
          return strict(out, 'HtmlOutput');
        }
      };
      return t;
    }
  }, 'HtmlService');

  const Session = strict({ getScriptTimeZone: () => scriptTz }, 'Session');
  const Charts = strict({ ChartHiddenDimensionStrategy: { IGNORE_BOTH: 'IGNORE_BOTH', IGNORE_ROWS: 'IGNORE_ROWS', IGNORE_COLUMNS: 'IGNORE_COLUMNS', SHOW_BOTH: 'SHOW_BOTH' } }, 'Charts');
  const LockService = strict({ getScriptLock: () => lock('script'), getDocumentLock: () => lock('document') }, 'LockService');
  const PropertiesService = strict({ getDocumentProperties: () => props }, 'PropertiesService');

  return {
    state,
    globals: { SpreadsheetApp, ScriptApp, Utilities, HtmlService, Session, Charts, LockService, PropertiesService, console },
    internals: { Sheet, Range, Spreadsheet, formatNumber, formatDate, dateToSerial, serialToDate, tzParts, instantFor, numToCol }
  };
}

module.exports = { createEnv, formatNumber, formatDate, numToCol, tzParts, instantFor };
