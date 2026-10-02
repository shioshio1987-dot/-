'use strict';
/**
 * モックで作ったスプレッドシートを HTML にして、見た目を確かめる（タブで切り替え）。
 *   TZ=Asia/Tokyo node test/render-preview.js 出力先.html
 * 患者一覧の条件付き書式は、使っている式（AND / NOT / ISNUMBER / COUNTIF / 比較）を
 * ここで計算して色を付ける。グラフは元データから簡単な SVG を描く。
 */
const fs = require('fs');
const { load } = require('./harness');
const { formatNumber, formatDate } = require('./gas-mock');

const out = process.argv[2] || 'preview.html';
const DAY = 86400000;
const TODAY = Date.UTC(2026, 9, 1);

// ---------- サンプルデータ（架空の患者・架空の料金） ----------
function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const COMBOS = [['AirSense10', 'フクダライフテック', 1100, 5], ['AirSense10', 'RISEF', 1200, 3], ['AirMini', 'フクダライフテック', 1300, 1],
  ['SleepStyle Auto Rx', 'チェスト', 1400, 2], ['DreamStation', 'フィリップス', 1500, 1], ['ムラタMX', 'チェスト', 1600, 1], ['SBOX', 'RISEF', 1700, 2]];
const FAMILY = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本'];
const GIVEN = ['太郎', '花子', '一郎', '次郎', '美咲', '健太', '陽子', '翔', '結衣', '大輔', '直子', '誠', '恵', '拓也', '由美'];
const REASONS = ['自己中断', '自己中断', '移管・転院', '経済的な理由', '症状の改善・不要', 'その他'];
const ymd = ms => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };

const t = load({});
const gs = t.gs;
gs.setup();
const r = rng(11);
const pool = [];
COMBOS.forEach(c => { for (let i = 0; i < c[3]; i++) pool.push(c); });
const rows = [];
for (let i = 0; i < 260; i++) {
  const c = pool[Math.floor(r() * pool.length)];
  const span = (TODAY - Date.UTC(2023, 3, 1)) / DAY;
  const intro = Date.UTC(2023, 3, 1) + Math.floor(Math.pow(r(), 0.8) * span) * DAY;
  let exit = null;
  let reason = '';
  if (r() < 0.25) {
    exit = intro + Math.floor((r() < 0.45 ? r() * 90 : r() * 700)) * DAY;
    if (exit > TODAY) exit = null; else reason = REASONS[Math.floor(r() * REASONS.length)];
  }
  const rep = exit === null && r() < 0.7;
  const d = ms => (ms === null ? '' : t.cellDate(...ymd(ms)));
  const mark = exit === null && r() < 0.6 ? '○' : '';
  rows.push([i + 1, FAMILY[Math.floor(r() * FAMILY.length)] + ' ' + GIVEN[Math.floor(r() * GIVEN.length)], c[0], c[1], '',
    rep ? d(Date.UTC(2026, 8, 1)) : '', rep ? d(Date.UTC(2026, 8, 30)) : '', mark, d(intro), d(exit),
    r() < 0.08 ? '夜間の装着が不安定' : '', '', reason]);
}
rows.sort((a, b) => a[8] - b[8]).forEach((row, i) => { row[0] = i + 1; });
t.grow('患者一覧', rows.length + 1);
t.sheet('患者一覧').getRange(2, 1, rows.length, 13).setValues(rows);
// 確認用に、わざと入力もれ・矛盾をいくつか入れる
const sh = t.sheet('患者一覧');
sh.getRange('D30').setValue('');
sh.getRange('A41').setValue(39);
sh.getRange('J52').setValue(t.cellDate(2023, 1, 5));
sh.getRange('M60').setValue('');
// マスタに架空の料金
const m = t.sheet('マスタ');
const mv = m.getRange(5, 1, 9, 7).getValues();
mv.forEach(row => { const c = COMBOS.find(x => x[0] === row[0] && x[1] === row[1]); if (c) row[4] = c[2]; });
m.getRange(5, 1, 9, 7).setValues(mv);
gs.refreshNow();
// 新しく1人、フォームから登録
gs.registerPatient({ name: '新規 登録', device: 'AirMini', supplier: 'フクダライフテック', intro: '2026-10-01', repStart: '', repEnd: '' });
gs.refreshNow();
t.typeIn('機器別一覧', 'C3', 'InfoSmart');
t.typeIn('機器別一覧', 'G3', '○のみ');

// ---------- 条件付き書式の式を計算する ----------
function cfEval(formula, sheet, row) {
  const src = formula.replace(/^=/, '');
  const toks = src.match(/"[^"]*"|\$?[A-Z]+\$?\d+|\$?[A-Z]+:\$?[A-Z]+|[A-Z]+(?=\()|<>|<=|>=|[=<>(),]|-?\d+(\.\d+)?/g);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const colNum = s => s.replace(/\$/g, '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const val = (c, rr) => {
    const cell = sheet._cell(rr, c);
    if (!cell || cell.v === undefined) return '';
    if (cell.v && typeof cell.v === 'object') return cell.v.__date;
    return cell.v;
  };
  function primary() {
    const tk = next();
    if (tk === '(') { const v = expr(); next(); return v; }
    if (tk.startsWith('"')) return tk.slice(1, -1);
    if (/^-?\d/.test(tk)) return Number(tk);
    if (/:/.test(tk)) { const [a] = tk.split(':'); return { col: colNum(a.replace(/\d/g, '')) }; }
    if (/^\$?[A-Z]+\$?\d+$/.test(tk) && peek() !== '(') {
      const m2 = /^\$?([A-Z]+)\$?(\d+)$/.exec(tk);
      return val(colNum(m2[1]), row + (Number(m2[2]) - 2));
    }
    next();   // '('
    const args = [];
    while (peek() !== ')') { args.push(expr()); if (peek() === ',') next(); }
    next();
    if (tk === 'AND') return args.every(Boolean);
    if (tk === 'OR') return args.some(Boolean);
    if (tk === 'NOT') return !args[0];
    if (tk === 'ISNUMBER') return typeof args[0] === 'number';
    if (tk === 'COUNTIF') {
      let n = 0;
      for (let rr = 1; rr <= sheet._maxRows; rr++) if (val(args[0].col, rr) === args[1] && args[1] !== '') n++;
      return n;
    }
    throw new Error('未対応の関数 ' + tk);
  }
  function expr() {
    let a = primary();
    const op = peek();
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      next();
      const b = primary();
      const eq = (x, y) => (x === '' && y === '') || x === y;
      return { '=': eq(a, b), '<>': !eq(a, b), '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[op];
    }
    return a;
  }
  return !!expr();
}

// ---------- グラフ（簡単な SVG） ----------
const COLORS = ['#2e75b6', '#c0504d', '#9bbb59', '#8064a2', '#4bacc6', '#f79646', '#7f7f7f'];
function chartSvg(ch) {
  const w = ch.options.width || 500;
  const h = ch.options.height || 300;
  const data = ch.ranges.map(rg => rg.getValues());
  let table = data[0].map((row, i) => row.concat(...data.slice(1).map(d => d[i])));
  const head = table[0];
  let body = table.slice(1);
  if (ch.reversed) body = body.slice().reverse();
  const title = `<text x="${w / 2}" y="20" text-anchor="middle" font-size="13" font-weight="bold">${ch.options.title || ''}</text>`;
  const colors = ch.options.colors || COLORS;
  let g = '';
  if (ch.type === 'pie') {
    const total = body.reduce((a, r) => a + (Number(r[1]) || 0), 0) || 1;
    let ang = -Math.PI / 2;
    const cx = w * 0.35, cy = h / 2 + 10, rad = Math.min(w, h) * 0.32;
    body.forEach((r, i) => {
      const a2 = ang + (Number(r[1]) / total) * Math.PI * 2;
      const large = a2 - ang > Math.PI ? 1 : 0;
      g += `<path d="M${cx},${cy} L${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)} A${rad},${rad} 0 ${large} 1 ${cx + rad * Math.cos(a2)},${cy + rad * Math.sin(a2)} Z" fill="${COLORS[i % COLORS.length]}" stroke="#fff"/>`;
      const mid = (ang + a2) / 2;
      g += `<text x="${cx + rad * 0.65 * Math.cos(mid)}" y="${cy + rad * 0.65 * Math.sin(mid) + 4}" fill="#fff" font-size="11" text-anchor="middle">${r[1]}</text>`;
      g += `<rect x="${w * 0.7}" y="${50 + i * 18}" width="10" height="10" fill="${COLORS[i % COLORS.length]}"/><text x="${w * 0.7 + 15}" y="${59 + i * 18}" font-size="11">${r[0]}</text>`;
      ang = a2;
    });
  } else {
    const series = head.slice(1);
    const max = Math.max(1, ...body.flatMap(r => r.slice(1).map(Number)));
    const left = 40, top = 34, bottom = h - 50, right = w - 14;
    const cw = (right - left) / Math.max(body.length, 1);
    g += `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#999"/>`;
    for (let k = 0; k <= 4; k++) {
      const y = bottom - (bottom - top) * k / 4;
      g += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#eee"/><text x="${left - 4}" y="${y + 4}" font-size="10" text-anchor="end">${Math.round(max * k / 4)}</text>`;
    }
    body.forEach((r, i) => {
      g += `<text x="${left + cw * (i + 0.5)}" y="${bottom + 14}" font-size="9" text-anchor="middle">${r[0]}</text>`;
      if (ch.type === 'column') {
        const bw = cw * 0.8 / series.length;
        series.forEach((s, j) => {
          const v = Number(r[j + 1]) || 0;
          const bh = (bottom - top) * v / max;
          g += `<rect x="${left + cw * i + cw * 0.1 + bw * j}" y="${bottom - bh}" width="${bw}" height="${bh}" fill="${colors[j % colors.length]}"/>`;
        });
      }
    });
    if (ch.type === 'line') {
      series.forEach((s, j) => {
        const pts = body.map((r, i) => `${left + cw * (i + 0.5)},${bottom - (bottom - top) * (Number(r[j + 1]) || 0) / max}`).join(' ');
        g += `<polyline points="${pts}" fill="none" stroke="${colors[j % colors.length]}" stroke-width="2"/>`;
      });
    }
    if ((ch.options.legend || {}).position !== 'none') {
      series.forEach((s, j) => { g += `<rect x="${left + j * 90}" y="${h - 18}" width="10" height="10" fill="${colors[j % colors.length]}"/><text x="${left + j * 90 + 14}" y="${h - 9}" font-size="11">${s}</text>`; });
    }
  }
  return `<svg width="${w}" height="${h}" style="background:#fff;border:1px solid #ccc">${title}${g}</svg>`;
}

// ---------- 1枚のシートを HTML に ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function renderSheet(sheet) {
  const maxR = Math.min(Math.max(sheet.getLastRow(), 1) + 3, 400);
  const maxC = Math.min(Math.max(sheet.getLastColumn(), 1), 30);
  const cols = [];
  for (let c = 1; c <= maxC; c++) if (!sheet._hiddenCols.has(c)) cols.push(c);
  const width = c => sheet._colWidths[c] || 100;
  const height = rr => sheet._rowHeights[rr] || 21;
  const covered = new Set();
  const anchor = {};
  sheet._merges.forEach(mg => {
    anchor[mg.r1 + ',' + mg.c1] = mg;
    for (let rr = mg.r1; rr <= mg.r2; rr++) for (let c = mg.c1; c <= mg.c2; c++) if (rr !== mg.r1 || c !== mg.c1) covered.add(rr + ',' + c);
  });
  const borders = new Set();
  sheet._borders.forEach(b => { for (let rr = b.r; rr < b.r + b.nr; rr++) for (let c = b.c; c < b.c + b.nc; c++) borders.add(rr + ',' + c); });
  const cfFor = (rr, c) => {
    for (const rule of sheet._cf) {
      const hit = rule.ranges.some(rg => rr >= rg._r && rr < rg._r + rg._nr && c >= rg._c && c < rg._c + rg._nc);
      if (hit && cfEval(rule.formula, sheet, rr)) return rule;
    }
    return null;
  };
  let html = `<table class="grid"><colgroup><col style="width:36px">${cols.map(c => `<col style="width:${width(c)}px">`).join('')}</colgroup>`;
  html += `<tr class="hdr"><th></th>${cols.map(c => `<th>${require('./gas-mock').numToCol(c)}</th>`).join('')}</tr>`;
  for (let rr = 1; rr <= maxR; rr++) {
    const frozen = rr === sheet._frozenRows ? ' class="frz"' : '';
    html += `<tr${frozen} style="height:${height(rr)}px"><th>${rr}</th>`;
    for (const c of cols) {
      const key = rr + ',' + c;
      if (covered.has(key)) continue;
      const cell = sheet._cell(rr, c) || {};
      const mg = anchor[key];
      let span = '';
      if (mg) {
        const cs = [];
        for (let k = mg.c1; k <= mg.c2; k++) if (!sheet._hiddenCols.has(k)) cs.push(k);
        span = ` colspan="${cs.length}" rowspan="${mg.r2 - mg.r1 + 1}"`;
      }
      const v = sheet._getValue(rr, c);
      let text = '';
      if (cell.rich) {
        let s = cell.rich._text;
        const parts = [];
        let pos = 0;
        cell.rich._links.forEach(l => { parts.push(esc(s.slice(pos, l.s))); parts.push(`<a href="#">${esc(s.slice(l.s, l.e))}</a>`); pos = l.e; });
        parts.push(esc(s.slice(pos)));
        text = parts.join('');
      } else if (cell.f) {
        const m2 = /^=SPARKLINE\(B(\d+),\{"charttype","bar";"max",(\d+)/.exec(cell.f);
        if (m2) {
          const n = Number(sheet._getValue(Number(m2[1]), 2)) || 0;
          text = `<div class="spark" style="width:${Math.round(100 * n / Number(m2[2]))}%"></div>`;
        } else text = `<span class="f">${esc(cell.f)}</span>`;
      } else if (v instanceof Date) {
        text = formatDate(v, t.ss._tz, 'yyyy/MM/dd');
      } else if (typeof v === 'number') {
        text = esc(formatNumber(v, cell.fmt && cell.fmt !== 'yyyy/mm/dd' ? cell.fmt : (cell.fmt === 'yyyy/mm/dd' ? '0' : null)));
      } else text = esc(v);
      const rightEmpty = () => {
        const nc = cols[cols.indexOf(c) + 1];
        if (!nc || covered.has(rr + ',' + nc) || anchor[rr + ',' + nc]) return false;
        const nv = sheet._getValue(rr, nc);
        const ncell = sheet._cell(rr, nc) || {};
        return (nv === '' || nv === null) && !ncell.f && !ncell.rich;
      };
      const overflow = !mg && !cell.wrap && typeof v === 'string' && v !== '' && !cell.rich && (!cell.ha || cell.ha === 'left') && rightEmpty();
      if (overflow) text = `<span class="ov">${text}</span>`;
      const rule = sheet._cf.length ? cfFor(rr, c) : null;
      const st = [];
      const bg = (rule && rule.bg) || cell.bg;
      if (bg) st.push('background:' + bg);
      const fc = (rule && rule.fc) || cell.fc;
      if (fc) st.push('color:' + fc);
      if (cell.fw === 'bold' || (rule && rule.bold)) st.push('font-weight:bold');
      if (cell.fs) st.push('font-size:' + cell.fs + 'pt');
      const align = cell.ha || (typeof v === 'number' || v instanceof Date ? 'right' : 'left');
      st.push('text-align:' + align);
      if (cell.va) st.push('vertical-align:' + (cell.va === 'middle' ? 'middle' : cell.va));
      st.push(cell.wrap ? 'white-space:normal' : 'white-space:nowrap');
      if (borders.has(key)) st.push('border:1px solid #c9c9c9');
      if (overflow) st.push('position:relative;overflow:visible');
      if (c === sheet._frozenCols) st.push('border-right:2px solid #999');
      const dv = cell.dv && cell.dv.crit.type === 'list' && cell.dv.crit.list.length < 40 && (sheet._name !== '患者一覧' || rr < 8) ? '<span class="dd">▾</span>' : '';
      html += `<td${span} style="${st.join(';')}">${text}${dv}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  // グラフを重ねる
  const xOf = c => 36 + cols.filter(k => k < c).reduce((a, k) => a + width(k), 0);
  const yOf = rr => 22 + Array.from({ length: rr - 1 }, (_, i) => height(i + 1)).reduce((a, b) => a + b, 0);
  const charts = sheet._charts.map(ch => `<div class="chart" style="left:${xOf(ch.pos.c)}px;top:${yOf(ch.pos.r)}px">${chartSvg(ch)}</div>`).join('');
  return `<div class="wrap">${html}${charts}</div>`;
}

const sheets = t.ss._sheets.filter(s => !s._hidden);
const tabs = sheets.map((s, i) => `<button class="tab${i === 0 ? ' on' : ''}" data-i="${i}" style="border-top:3px solid ${s._tabColor || '#ccc'}">${esc(s._name)}</button>`).join('');
const pages = sheets.map((s, i) => `<section class="page${i === 0 ? ' on' : ''}" id="p${i}">${renderSheet(s)}</section>`).join('');
const doc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>CPAP管理 プレビュー</title>
<style>
body{margin:0;font:13px/1.35 Arial,"Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",sans-serif;background:#f8f9fa;color:#202124}
.page{display:none;overflow:auto;height:calc(100vh - 44px)}.page.on{display:block}
.wrap{position:relative;display:inline-block;background:#fff}
table.grid{border-collapse:collapse;table-layout:fixed;font-size:10pt}
table.grid td{border:1px solid #ececec;padding:1px 4px;overflow:hidden;text-overflow:clip;max-width:0;vertical-align:bottom}
table.grid th{background:#f1f3f4;color:#666;font-weight:normal;font-size:9pt;border:1px solid #ddd}
tr.frz td,tr.frz th{border-bottom:2px solid #999}
.ov{position:absolute;left:4px;top:50%;transform:translateY(-50%);white-space:nowrap;z-index:1;pointer-events:none}
.spark{height:10px;background:#2e75b6}.f{color:#999;font-size:8pt}.dd{float:right;color:#777;font-size:9pt;margin-left:2px}
a{color:#1155cc}.chart{position:absolute}
nav{position:fixed;bottom:0;left:0;right:0;height:44px;background:#f1f3f4;border-top:1px solid #ccc;display:flex;gap:2px;padding:4px;overflow-x:auto}
.tab{border:none;background:#e8eaed;padding:6px 12px;cursor:pointer;font:inherit;white-space:nowrap}.tab.on{background:#fff;font-weight:bold;color:#1a73e8}
</style></head><body>${pages}<nav>${tabs}</nav>
<script>document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab,.page').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.getElementById('p'+b.dataset.i).classList.add('on');});</script>
</body></html>`;
fs.writeFileSync(out, doc);
console.log('書き出し:', out, '/ タブ:', sheets.map(s => s._name).join('、'));
