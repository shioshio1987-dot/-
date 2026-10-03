'use strict';
/**
 * Code.gs のテスト。モックの上で、実際の操作の流れどおりに動かして結果を確かめる。
 *   node test/run-tests.js                 … 全シナリオ（タイムゾーンごとに別プロセスで実行）
 *   TZ=Asia/Tokyo node test/run-tests.js main   … 1つだけ
 * 期待値はテスト側で独立に計算する（Code.gs の計算をそのまま使わない）。
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const scenario = process.argv[2];
if (!scenario) {
  const runs = [
    ['Asia/Tokyo', 'main', ''],
    ['Asia/Tokyo', 'import', ''],
    ['Asia/Tokyo', 'upgrade', ''],
    ['Asia/Tokyo', 'refill', ''],
    ['Asia/Tokyo', 'collision', ''],
    ['Asia/Tokyo', 'big', ''],
    ['America/New_York', 'tz', 'Asia/Tokyo'],          // スクリプトは NY、シートは東京
    ['Asia/Tokyo', 'tz', 'America/Los_Angeles']          // スクリプトは東京、シートは LA
  ];
  let failed = 0;
  for (const [tz, name, sheetTz] of runs) {
    try {
      const out = execFileSync(process.execPath, [__filename, name, sheetTz], {
        env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8'
      });
      process.stdout.write(out);
    } catch (e) {
      failed++;
      process.stdout.write(e.stdout || '');
      process.stdout.write(e.stderr || String(e));
    }
  }
  console.log(failed ? `\n${failed} 個のシナリオで失敗があります` : '\nすべてのシナリオが通りました');
  process.exit(failed ? 1 : 0);
}

const { load } = require('./harness');
const sheetTzArg = process.argv[3] || undefined;
let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
function finish() {
  console.log(`[${scenario} / script TZ=${process.env.TZ}${sheetTzArg ? ' / sheet TZ=' + sheetTzArg : ''}] ${pass} 件OK` +
    (fail ? `、${fail} 件失敗` : ''));
  process.exit(fail ? 1 : 0);
}

// ---------- テスト用のデータ（料金は架空） ----------
const COMBOS = [
  ['AirSense10', 'フクダライフテック', 1100, false],
  ['AirSense10', 'RISEF', 1200, false],
  ['AirMini', 'フクダライフテック', 1300, false],
  ['SleepStyle Auto Rx', 'チェスト', 1400, true],
  ['DreamStation', 'フィリップス', 1500, false],
  ['ムラタMX', 'チェスト', 1600, true],
  ['SBOX', 'RISEF', 1700, false]
];
const REASONS = ['自己中断', '移管・転院', '経済的な理由', '症状の改善・不要', 'その他'];
const DAY = 86400000;
const TODAY = Date.UTC(2026, 9, 1);   // 2026/10/01（テストの「今日」）

function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ymd = ms => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const pad = n => String(n).padStart(2, '0');
const fmt = ms => { const [y, m, d] = ymd(ms); return `${y}/${pad(m)}/${pad(d)}`; };

function makePatients(n, seed) {
  const r = rng(seed);
  const start = Date.UTC(2023, 0, 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = COMBOS[Math.floor(r() * COMBOS.length)];
    const intro = start + Math.floor(r() * ((TODAY - start) / DAY + 1)) * DAY;
    let exit = null;
    let reason = '';
    if (r() < 0.32) {
      const days = r() < 0.4 ? Math.floor(r() * 90) : Math.floor(r() * 900);
      exit = intro + days * DAY;
      if (exit > TODAY + 30 * DAY) exit = null;
      if (exit !== null) reason = REASONS[Math.floor(r() * REASONS.length)];
      if (exit !== null && r() < 0.1) reason = '';
    }
    const rep = r() < 0.6 && (exit === null || exit > TODAY);
    const target = (exit === null || exit > TODAY) && r() < 0.5;
    out.push({
      id: i + 1, name: `患者${String(i + 1).padStart(4, '0')}`, device: c[0], supplier: c[1], price: c[2], free: c[3],
      intro, exit, reason, repStart: rep ? Date.UTC(2026, 8, 1) : null, repEnd: rep ? Date.UTC(2026, 8, 30) : null,
      target, visit: rep ? Math.max(Date.UTC(2026, 8, 1), intro) : null, note: r() < 0.1 ? 'メモあり' : ''
    });
  }
  return out;
}

/** 患者一覧にまとめて書き込む（貼り付けと同じ。状態は空のまま → 集計のときに自動で入る） */
function writeLedger(t, patients, startRow) {
  const d = ms => (ms === null ? '' : t.cellDate(...ymd(ms)));
  const rows = patients.map(p => [p.id, p.name, p.device, p.supplier, '', d(p.repStart), d(p.repEnd), p.target ? '○' : '',
    d(p.intro), d(p.visit), d(p.exit), p.note, '', p.reason]);
  t.grow('患者一覧', (startRow || 2) + rows.length - 1);
  t.sheet('患者一覧').getRange(startRow || 2, 1, rows.length, 14).setValues(rows);
}

// ---------- 期待値（Code.gs とは別に計算） ----------
const isActiveAt = (p, day) => p.intro <= day && (p.exit === null || p.exit > day);
const status = p => (p.exit !== null && p.exit <= TODAY ? '離脱' : '利用中');
function monthsBetween(a, b) {
  const [y1, m1, d1] = ymd(a);
  const [y2, m2, d2] = ymd(b);
  return Math.max((y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0), 0);
}
function addMonths(ms, k) {
  const [y, m, d] = ymd(ms);
  const first = Date.UTC(y, m - 1 + k, 1);
  const last = new Date(Date.UTC(y, m + k, 0)).getUTCDate();
  return first + (Math.min(d, last) - 1) * DAY;
}
function expectedMonths(patients) {
  const first = Math.min(...patients.map(p => p.intro));
  const out = {};
  let [y, m] = ymd(first);
  for (;;) {
    const s = Date.UTC(y, m - 1, 1);
    if (s > TODAY) break;
    const e = Math.min(Date.UTC(y, m, 0), TODAY);
    out[`${y}/${pad(m)}`] = {
      intro: patients.filter(p => p.intro >= s && p.intro <= e).length,
      exit: patients.filter(p => p.exit !== null && p.exit >= s && p.exit <= e).length,
      active: patients.filter(p => isActiveAt(p, e)).length
    };
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
function weekStart(ms) { const dow = new Date(ms).getUTCDay(); return ms - ((dow + 6) % 7) * DAY; }
function expectedWeeks(patients) {
  const out = {};
  for (let s = weekStart(Math.min(...patients.map(p => p.intro))); s <= TODAY; s += 7 * DAY) {
    const e = Math.min(s + 6 * DAY, TODAY);
    const [y1] = ymd(s);
    const [y2, m2, d2] = ymd(s + 6 * DAY);
    const label = fmt(s) + '〜' + (y1 === y2 ? `${pad(m2)}/${pad(d2)}` : fmt(s + 6 * DAY));
    out[label] = {
      intro: patients.filter(p => p.intro >= s && p.intro <= e).length,
      exit: patients.filter(p => p.exit !== null && p.exit >= s && p.exit <= e).length,
      active: patients.filter(p => isActiveAt(p, e)).length
    };
  }
  return out;
}
function tableByLabel(t, sheetName, fromRow, width) {
  const sh = t.sheet(sheetName);
  const last = sh.getLastRow();
  const vals = sh.getRange(fromRow, 1, last - fromRow + 1, width).getValues();
  const map = {};
  vals.forEach(r => { if (r[0] !== '') map[r[0]] = r; });
  return map;
}

/** シート全体に、指定した文字が含まれるか */
function sheetContains(t, name, needle) {
  const sh = t.sheet(name);
  for (const cell of sh._cells.values()) if (typeof cell.v === 'string' && cell.v.includes(needle)) return true;
  return false;
}

// =====================================================================
// シナリオ：通常の使い方（セットアップ → 入力 → 集計）
// =====================================================================
function scenarioMain() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;

  test('onOpen：メニューができ、未セットアップの案内が出る', () => {
    gs.onOpen();
    assert.strictEqual(t.state.menus[0].name, 'CPAP管理');
    assert.ok(t.lastToast().includes('初期セットアップ'));
  });

  test('setup：タブが決まった順に並び、患者一覧の見出しが正しい', () => {
    gs.setup();
    const names = t.ss.getSheets().map(s => s.getName());
    assert.deepStrictEqual(names.slice(0, 10),
      ['患者一覧', 'ダッシュボード', '月別', '週別', '年別', '機器別一覧', '離脱分析', '台数・費用', 'マスタ', '使い方']);
    assert.deepStrictEqual(t.display('患者一覧', 'A1:N1')[0],
      ['ID', '名前', '機器', '業者', 'クラウド区分', 'レポート開始日', 'レポート終了日', '対象', '導入日', '最終通院日', '離脱日', '備考', '状態', '離脱理由']);
    assert.strictEqual(t.state.triggers.length, 1);
    assert.strictEqual(t.state.triggers[0].getHandlerFunction(), 'autoRefresh');
    const last = t.state.alerts[t.state.alerts.length - 1];
    assert.strictEqual(last.title, 'セットアップ完了');
  });

  test('setup：マスタに機器・業者・離脱理由の初期値が入り、料金は空', () => {
    const v = t.values('マスタ', 'A5:G13');
    assert.strictEqual(v[0][0], 'AirSense10');
    assert.strictEqual(v[0][1], 'フクダライフテック');
    assert.ok(v.every(r => r[4] === ''), '料金は入れない');
    assert.strictEqual(t.values('マスタ', 'I4')[0][0], '離脱理由の候補');
    assert.strictEqual(t.values('マスタ', 'I5')[0][0], '自己中断');
  });

  test('setup：ドロップダウン・日付の入力規則・色分け・フィルタ・見出しの保護', () => {
    const sh = t.sheet('患者一覧');
    const dev = sh.getRange('C2').getDataValidation();
    assert.ok(dev.crit.list.includes('SBOX（加湿器付）'));
    assert.strictEqual(sh.getRange('D2').getDataValidation().crit.list.length, 4);
    assert.deepStrictEqual(Array.from(sh.getRange('M2').getDataValidation().crit.list), ['利用中', '離脱']);
    assert.deepStrictEqual(Array.from(sh.getRange('H2').getDataValidation().crit.list), ['○']);
    assert.ok(Array.from(sh.getRange('E2').getDataValidation().crit.list).includes('InfoSmart'));
    assert.strictEqual(sh.getRange('I500').getDataValidation().crit.type, 'date');
    assert.ok(sh.getConditionalFormatRules().length >= 12);
    assert.ok(sh.getFilter());
    assert.strictEqual(sh.getProtections('RANGE').length, 1);
    assert.strictEqual(sh.getFrozenRows(), 1);
    assert.strictEqual(sh.getFrozenColumns(), 2);
  });

  test('入力：名前を入れると ID=1 と 状態=利用中', () => {
    t.typeIn('患者一覧', 'B2', '山田 太郎');
    assert.deepStrictEqual(t.values('患者一覧', 'A2:N2')[0].filter((x, i) => [0, 12].includes(i)), [1, '利用中']);
  });

  test('入力：業者が1社だけの機器は業者が自動で入る／複数なら案内', () => {
    t.typeIn('患者一覧', 'C2', 'SleepStyle Auto Rx');
    assert.strictEqual(t.values('患者一覧', 'D2')[0][0], 'チェスト');
    t.typeIn('患者一覧', 'B3', '佐藤 花子');
    t.typeIn('患者一覧', 'C3', 'AirSense10');
    assert.strictEqual(t.values('患者一覧', 'D3')[0][0], '');
    assert.ok(t.lastToast().includes('フクダライフテック／RISEF'));
    assert.strictEqual(t.values('患者一覧', 'A3')[0][0], 2);
  });

  test('入力：機器を選ぶとクラウド区分が入る（機器を変えると変わる）', () => {
    assert.strictEqual(t.values('患者一覧', 'E2')[0][0], 'InfoSmart');
    assert.strictEqual(t.values('患者一覧', 'E3')[0][0], 'AirView');
    t.typeIn('患者一覧', 'C2', 'ムラタMX');
    assert.strictEqual(t.values('患者一覧', 'E2')[0][0], 'CSC');
    t.typeIn('患者一覧', 'C2', 'SleepStyle Auto Rx');
    assert.strictEqual(t.values('患者一覧', 'E2')[0][0], 'InfoSmart');
  });

  test('入力：組み合わせがマスタにないと案内', () => {
    t.typeIn('患者一覧', 'D3', 'チェスト');
    assert.ok(t.lastToast().includes('組み合わせは［マスタ］にありません'));
    t.typeIn('患者一覧', 'D3', 'RISEF');
  });

  test('入力：t／y／8桁／和暦／全角／月日だけ を日付に直す', () => {
    const cases = [
      ['t', '2026/10/01'], ['y', '2026/09/30'], ['20260901', '2026/09/01'], ['R8.8.15', '2026/08/15'],
      ['令和7年4月1日', '2025/04/01'], ['２０２６／７／１', '2026/07/01'], ['2026.6.3', '2026/06/03'],
      ['9/5', '2026/09/05'], ['H31.4.30', '2019/04/30']
    ];
    for (const [input, want] of cases) {
      t.typeIn('患者一覧', 'I3', input);
      const v = t.values('患者一覧', 'I3')[0][0];
      assert.ok(v instanceof Date, input + ' が日付になっていない');
      assert.strictEqual(t.ymdOf(v), want, input);
      assert.ok(t.isMidnight(v), input + ' が0時になっていない');
    }
    t.typeIn('患者一覧', 'I3', 'あした');
    assert.strictEqual(t.values('患者一覧', 'I3')[0][0], 'あした');
    assert.ok(t.lastToast().includes('日付として読めません'));
    t.typeIn('患者一覧', 'I3', '2026/9/1');
    t.typeIn('患者一覧', 'I2', '2026/8/20');
  });

  test('入力：離脱日 → 離脱／消す → 利用中／未来の日付 → 利用中のまま', () => {
    t.typeIn('患者一覧', 'K2', 'y');
    assert.strictEqual(t.values('患者一覧', 'M2')[0][0], '離脱');
    assert.ok(t.lastToast().includes('離脱理由も選んでください'));
    t.typeIn('患者一覧', 'K2', '');
    assert.strictEqual(t.values('患者一覧', 'M2')[0][0], '利用中');
    t.typeIn('患者一覧', 'K2', '2026/10/20');
    assert.strictEqual(t.values('患者一覧', 'M2')[0][0], '利用中');
    assert.ok(t.lastToast().includes('未来の日付'));
    t.typeIn('患者一覧', 'K2', '2026/9/28');
    assert.strictEqual(t.values('患者一覧', 'M2')[0][0], '離脱');
    t.typeIn('患者一覧', 'M2', '利用中');
    assert.strictEqual(t.values('患者一覧', 'M2')[0][0], '離脱', '離脱日があるので戻す');
    assert.ok(t.lastToast().includes('離脱日を消してください'));
    t.typeIn('患者一覧', 'N2', '自己中断');
  });

  test('入力：レポート期間の前後が逆なら案内', () => {
    t.typeIn('患者一覧', 'F3', '2026/9/30');
    t.typeIn('患者一覧', 'G3', '2026/9/1');
    assert.ok(t.lastToast().includes('レポート終了日が開始日より前'));
    t.typeIn('患者一覧', 'G3', '');
    t.typeIn('患者一覧', 'F3', '');
  });

  test('最終通院日：入れるとレポート開始日に同じ日、終了日は「いつも昨日」の式（v17と同じ）', () => {
    const sh = t.sheet('患者一覧');
    const period = () => t.display('患者一覧', 'F3:G3')[0];
    t.typeIn('患者一覧', 'J3', '2026/9/15');
    assert.deepStrictEqual(period(), ['2026/09/15', '2026/09/30']);
    assert.strictEqual(sh.getRange('G3').getFormula(), '=TODAY()-1');
    t.typeIn('患者一覧', 'J3', 't');                       // 通院のたびに上書き（当日は 開始日＝今日・終了日＝昨日）
    assert.deepStrictEqual(period(), ['2026/10/01', '2026/09/30']);
    t.typeIn('患者一覧', 'G3', '2026/9/20');               // 終了日を手で固定 → 次の通院で式に戻る
    assert.strictEqual(sh.getRange('G3').getFormula(), '');
    t.typeIn('患者一覧', 'J3', '2026/9/25');
    assert.deepStrictEqual(period(), ['2026/09/25', '2026/09/30']);
    assert.strictEqual(sh.getRange('G3').getFormula(), '=TODAY()-1');
    t.typeIn('患者一覧', 'J3', '');                        // 最終通院日を消しても期間はそのまま
    assert.deepStrictEqual(period(), ['2026/09/25', '2026/09/30']);
    t.paste('患者一覧', 3, 6, [['2026/9/1', '2026/9/30', '', '2026/9/1', '2026/9/10']]);   // 期間も一緒に入れたらそちらを優先
    assert.deepStrictEqual(period(), ['2026/09/01', '2026/09/30']);
    assert.strictEqual(sh.getRange('G3').getFormula(), '');
    assert.strictEqual(t.display('患者一覧', 'J3')[0][0], '2026/09/10');
    t.typeIn('患者一覧', 'G3', '');
    t.typeIn('患者一覧', 'F3', '');
  });

  test('入力：複数行の貼り付けでもIDと状態が入る', () => {
    t.paste('患者一覧', 4, 2, [['鈴木 一郎', 'DreamStation'], ['高橋 次郎', 'SBOX']]);
    const v = t.values('患者一覧', 'A4:M5');
    assert.deepStrictEqual([v[0][0], v[1][0]], [3, 4]);
    assert.deepStrictEqual([v[0][3], v[1][3]], ['フィリップス', 'RISEF']);
    assert.deepStrictEqual([v[0][12], v[1][12]], ['利用中', '利用中']);
  });

  test('サイドバー：初期データ（次のID・先月・今月）', () => {
    const d = gs.getFormData();
    assert.strictEqual(d.nextId, 5);
    assert.strictEqual(d.today, '2026-10-01');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(d.lastMonth)), { start: '2026-09-01', end: '2026-09-30' });
    assert.strictEqual(d.thisMonth.end, '', '今日が1日なので今月は使えない');
    assert.deepStrictEqual(Array.from(d.deviceSuppliers.AirSense10), ['フクダライフテック', 'RISEF']);
  });

  test('サイドバー：新規登録（同姓同名の確認・IDの重複・組み合わせ違い）', () => {
    const base = { name: '伊藤 三郎', device: 'AirMini', supplier: 'RISEF', intro: '2026-09-10', repStart: '', repEnd: '', note: 'テスト' };
    const r = gs.registerPatient(base);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.nextId, 6);
    const row = t.values('患者一覧', 'A6:N6')[0];
    assert.deepStrictEqual([row[0], row[1], row[2], row[3], row[7], t.ymdOf(row[8]), row[11], row[12]],
      [5, '伊藤 三郎', 'AirMini', 'RISEF', '○', '2026/09/10', 'テスト', '利用中'], '対象は最初から○');
    assert.ok(t.isMidnight(row[8]));
    assert.strictEqual(row[4], 'AirView', '機器からクラウド区分が入る');
    assert.deepStrictEqual([t.ymdOf(row[9]), t.ymdOf(row[5]), t.ymdOf(row[6])], ['2026/09/10', '2026/09/10', '2026/09/30'],
      '最終通院日は導入日、レポート期間は最終通院日〜昨日');
    assert.strictEqual(t.sheet('患者一覧').getRange('G6').getFormula(), '=TODAY()-1');
    assert.strictEqual(gs.registerPatient(Object.assign({}, base, { name: '伊藤　三郎' })).status, 'dup');
    assert.strictEqual(gs.registerPatient(Object.assign({}, base, { force: true })).status, 'ok');
    assert.throws(() => gs.registerPatient(Object.assign({}, base, { name: '別人', id: '5' })), /すでに使われています/);
    assert.throws(() => gs.registerPatient(Object.assign({}, base, { name: '別人', supplier: 'チェスト' })), /から選んでください/);
    assert.throws(() => gs.registerPatient(Object.assign({}, base, { name: '別人', repStart: '2026-09-10' })), /両方/);
    const r2 = gs.registerPatient({ name: '渡辺 四郎', device: 'SBOX', supplier: 'RISEF', intro: '2026-09-25',
      repStart: '2026-09-25', repEnd: '2026-09-30', id: '' });
    assert.strictEqual(r2.status, 'ok');
    assert.strictEqual(t.ymdOf(t.values('患者一覧', 'G8')[0][0]), '2026/09/30');
  });

  test('レポート期間：選んだ行に「先月」を入れる（離脱・空行・非表示は除く）', () => {
    t.sheet('患者一覧')._hiddenByFilter.add(5);
    t.select('患者一覧', ['B2:B5', 'A10']);
    const info = gs.getSelectionInfo();
    assert.ok(info.message.includes('選択中：2人'), info.message);
    assert.ok(info.message.includes('離脱 1人'));
    assert.ok(info.message.includes('非表示 1行'));
    const res = gs.applyReportPeriod({ mode: 'fixed', start: '2026-09-01', end: '2026-09-30' });
    assert.ok(res.message.includes('2人'));
    assert.deepStrictEqual(t.display('患者一覧', 'F3:G4'), [['2026/09/01', '2026/09/30'], ['2026/09/01', '2026/09/30']]);
    assert.deepStrictEqual(t.display('患者一覧', 'F2:G2'), [['2026/08/20', '2026/09/30']], '離脱した人は変えない');
    assert.deepStrictEqual(t.display('患者一覧', 'F5:G5'), [['', '']]);
    t.sheet('患者一覧')._hiddenByFilter.clear();
  });

  test('レポート期間：「前回の続き」と「消す」', () => {
    t.select('患者一覧', ['A3:A6']);
    const res = gs.applyReportPeriod({ mode: 'continue', end: '2026-09-30' });
    // 3・4行目は前回の終了日が 9/30 なので入らない（前の期間のまま）、5行目は導入日がない、
    // 6行目は終了日が「いつも昨日」の式（最終通院日から）なのでそのまま
    assert.deepStrictEqual(t.display('患者一覧', 'F3:G6'), [
      ['2026/09/01', '2026/09/30'], ['2026/09/01', '2026/09/30'], ['', ''], ['2026/09/10', '2026/09/30']]);
    assert.ok(res.message.includes('入れなかった行'), res.message);
    assert.ok(res.message.includes('6行目（終了日が「いつも昨日」の式です）'), res.message);
    assert.strictEqual(t.sheet('患者一覧').getRange('G6').getFormula(), '=TODAY()-1', '式のまま');
    t.select('患者一覧', ['A6']);
    gs.applyReportPeriod({ mode: 'clear' });
    assert.deepStrictEqual(t.display('患者一覧', 'F6:G6'), [['', '']]);
    t.select('ダッシュボード', ['A1']);
    assert.throws(() => gs.getSelectionInfo(), /患者一覧/);
  });

  test('導入日・新規登録から、最終通院日とレポート期間が入る（入っている欄は変えない）', () => {
    const sh = t.sheet('患者一覧');
    t.typeIn('患者一覧', 'B11', 'リンク 太郎');
    t.typeIn('患者一覧', 'C11', 'SBOX');
    t.typeIn('患者一覧', 'I11', '2026/9/5');
    assert.deepStrictEqual(t.display('患者一覧', 'F11:J11')[0], ['2026/09/05', '2026/09/30', '', '2026/09/05', '2026/09/05']);
    assert.strictEqual(sh.getRange('G11').getFormula(), '=TODAY()-1');
    t.typeIn('患者一覧', 'I11', '2026/9/3');
    assert.strictEqual(t.display('患者一覧', 'J11')[0][0], '2026/09/05', '最終通院日が入っていれば変えない');
    t.typeIn('患者一覧', 'B12', 'リンク 花子');
    t.typeIn('患者一覧', 'C12', 'SBOX');
    t.typeIn('患者一覧', 'F12', '2026/9/1');
    t.typeIn('患者一覧', 'G12', '2026/9/30');
    t.typeIn('患者一覧', 'I12', '2026/8/1');
    assert.deepStrictEqual(t.display('患者一覧', 'F12:J12')[0], ['2026/09/01', '2026/09/30', '', '2026/08/01', '2026/08/01']);
    assert.strictEqual(sh.getRange('G12').getFormula(), '', '手で入れた期間はそのまま');
    const base = { device: 'SBOX', supplier: 'RISEF', repStart: '', repEnd: '' };
    gs.registerPatient(Object.assign({ name: 'リンク 次郎', intro: '2026-01-10', visit: '2026-09-25' }, base));
    assert.deepStrictEqual(t.display('患者一覧', 'F13:J13')[0], ['2026/09/25', '2026/09/30', '○', '2026/01/10', '2026/09/25']);
    assert.strictEqual(sh.getRange('G13').getFormula(), '=TODAY()-1');
    assert.throws(() => gs.registerPatient(Object.assign({ name: 'リンク 四郎', intro: '2026-09-10', visit: '2026-09-01' }, base)),
      /導入日より前/);
    assert.throws(() => gs.registerPatient(Object.assign({ name: 'リンク 五郎', intro: '2026-09-10', visit: '2026-10-05' }, base)),
      /今日より後/);
    sh.getRange('A11:N13').clearContent();
  });

  test('対象（○）：何を入れても○、×・x・0 は空欄', () => {
    t.typeIn('患者一覧', 'B9', '対象 テスト');
    for (const [input, want] of [['あ', '○'], ['x', ''], ['〇', '○'], ['×', ''], ['0', ''], ['1', '○'], ['', ''], ['○', '○']]) {
      t.typeIn('患者一覧', 'H9', input);
      assert.strictEqual(t.values('患者一覧', 'H9')[0][0], want, JSON.stringify(input));
    }
  });

  test('対象（○）：離脱日を入れると○が外れる（旧バージョンと同じ）', () => {
    t.typeIn('患者一覧', 'I9', '2026/9/1');
    t.typeIn('患者一覧', 'K9', 'y');
    assert.strictEqual(t.values('患者一覧', 'H9')[0][0], '');
    assert.ok(t.lastToast().includes('対象（○）を外しました'), t.lastToast());
  });

  test('対象（○）：選んだ行に付ける・外す／期間と一緒に付ける', () => {
    t.select('患者一覧', ['A3:A4']);
    gs.setTargetMarks({ mode: 'off' });
    assert.deepStrictEqual(t.values('患者一覧', 'H3:H4'), [[''], ['']]);
    gs.setTargetMarks({ mode: 'on' });
    assert.deepStrictEqual(t.values('患者一覧', 'H3:H4'), [['○'], ['○']]);
    t.select('患者一覧', ['A9']);
    assert.throws(() => gs.setTargetMarks({ mode: 'on' }), /対象の行がありません/, '離脱した人には付けない');
    t.select('患者一覧', ['A3:A4']);
    gs.setTargetMarks({ mode: 'off' });
    const r = gs.applyReportPeriod({ mode: 'fixed', start: '2026-09-01', end: '2026-09-30', mark: true });
    assert.ok(r.message.includes('○も付けました'), r.message);
    assert.deepStrictEqual(t.values('患者一覧', 'H3:H4'), [['○'], ['○']]);
    const info = gs.getSelectionInfo();
    assert.ok(info.message.includes('対象（○）が付いている人：2人'), info.message);
  });

  test('対象（○）をすべて消す（メニュー・人数を見せて確認・期間は残す）', () => {
    const n = gs.clearAllTargets({}).count;
    assert.ok(n >= 2, String(n));
    t.state.responses.push('CANCEL');
    gs.clearTargetMarks();
    assert.strictEqual(gs.clearAllTargets({}).count, n, 'キャンセルなら消さない');
    gs.clearTargetMarks();
    const a = t.state.alerts[t.state.alerts.length - 1];
    assert.ok(a.prompt.includes('いま ' + n + '人に「○」'), a.prompt);
    assert.strictEqual(gs.clearAllTargets({}).count, 0);
    assert.deepStrictEqual(t.display('患者一覧', 'F3:G3'), [['2026/09/01', '2026/09/30']], '期間は残る');
    gs.clearTargetMarks();
    assert.ok(t.state.alerts[t.state.alerts.length - 1].prompt.includes('付いている人はいません'));
  });

  // ---- まとまったデータで集計を確かめる ----
  const patients = makePatients(400, 7);
  test('集計：400人を貼り付けて［集計を今すぐ更新］', () => {
    const sh = t.sheet('患者一覧');
    sh.getRange(2, 1, sh.getLastRow() - 1, 14).clearContent();
    writeLedger(t, patients);
    gs.refreshNow();
    assert.ok(t.lastToast().includes('400人'), t.lastToast());
    const st = t.values('患者一覧', 'M2:M401').map(r => r[0]);
    assert.deepStrictEqual(st, patients.map(status), '状態が離脱日に合わせて入る');
  });

  test('ダッシュボード：カードの数字', () => {
    const v = t.values('ダッシュボード', 'A5:K5')[0];
    const mStart = Date.UTC(2026, 9, 1);
    const lmStart = Date.UTC(2026, 8, 1);
    const wStart = weekStart(TODAY);
    assert.strictEqual(v[0], patients.filter(p => status(p) === '利用中').length, '現在の利用者');
    assert.strictEqual(v[1], patients.filter(p => p.intro >= mStart && p.intro <= TODAY).length, '今月の導入');
    assert.strictEqual(v[3], patients.filter(p => p.exit !== null && p.exit >= mStart && p.exit <= TODAY).length, '今月の離脱');
    assert.strictEqual(v[6], patients.filter(p => p.intro >= wStart && p.intro <= TODAY).length, '今週の導入');
    assert.strictEqual(v[8], 400, '累計');
    assert.strictEqual(v[9], patients.filter(p => p.target).length, '対象（○）');
    const noPeriod = patients.filter(p => p.target && p.repStart === null).length;
    assert.strictEqual(t.values('ダッシュボード', 'J6')[0][0], 'うち期間なし ' + noPeriod + '人');
    const elig = patients.filter(p => addMonths(p.intro, 12) <= TODAY);
    const kept = elig.filter(p => p.exit === null || p.exit >= addMonths(p.intro, 12));
    assert.ok(Math.abs(v[10] - kept.length / elig.length) < 1e-9, '1年継続率');
    const sub = t.values('ダッシュボード', 'A6:K6')[0];
    assert.strictEqual(sub[0], '先月末 ' + patients.filter(p => isActiveAt(p, mStart - DAY)).length + '人');
    assert.strictEqual(sub[1], '先月 ' + patients.filter(p => p.intro >= lmStart && p.intro < mStart).length + '人');
  });

  test('ダッシュボード：機器別・業者別の表（合計＝人数）', () => {
    const pos = t.find('ダッシュボード', '機器別（いま）');
    assert.deepStrictEqual(pos, [8, 1]);
    const rows = t.values('ダッシュボード', 'A10:E20');
    const byName = {};
    rows.forEach(r => { byName[r[0]] = r; });
    for (const dev of ['AirSense10', 'SBOX', 'ムラタMX']) {
      const mine = patients.filter(p => p.device === dev);
      assert.deepStrictEqual(byName[dev].slice(1, 5).map(Number), [
        mine.filter(p => status(p) === '利用中').length,
        mine.filter(p => p.intro >= Date.UTC(2026, 9, 1) && p.intro <= TODAY).length,
        mine.filter(p => status(p) === '離脱').length, mine.length], dev);
    }
    assert.strictEqual(byName['合計'][4], 400);
    assert.ok(!byName['SBOX（加湿器付）'], '患者がいない機器は出さない');
  });

  test('ダッシュボード：グラフ4つ（隠し列のデータを使う）', () => {
    const sh = t.sheet('ダッシュボード');
    assert.strictEqual(sh.getCharts().length, 4);
    assert.ok(sh.getCharts().every(c => c.hiddenStrategy === 'SHOW_BOTH'));
    assert.ok(sh._hiddenCols.has(13) && sh._hiddenCols.has(24));
    const m = t.values('ダッシュボード', 'M3:O14');
    assert.strictEqual(m[11][0], '2026/10');
    const exp = expectedMonths(patients);
    assert.deepStrictEqual(m[11].slice(1), [exp['2026/10'].intro, exp['2026/10'].exit]);
  });

  test('ダッシュボード：入力チェックは問題なし', () => {
    assert.ok(t.find('ダッシュボード', '✓ 問題は見つかりませんでした') ||
      t.find('ダッシュボード', '離脱理由が空欄'), '空欄の理由だけは出てもよい');
    const pos = t.find('ダッシュボード', '離脱理由が空欄');
    if (pos) {
      const n = patients.filter(p => status(p) === '離脱' && !p.reason).length;
      assert.strictEqual(t.values('ダッシュボード', 'D' + pos[0])[0][0], n + '件');
    }
  });

  test('月別：すべての月の導入数・離脱数・月末の利用者数', () => {
    const exp = expectedMonths(patients);
    const got = tableByLabel(t, '月別', 6, 5);
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(exp).sort());
    for (const k of Object.keys(exp)) {
      assert.deepStrictEqual([got[k][1], got[k][2], got[k][3], got[k][4]],
        [exp[k].intro, exp[k].exit, exp[k].intro - exp[k].exit, exp[k].active], k);
    }
    assert.strictEqual(t.values('月別', 'A6')[0][0], '2026/10', '新しい順');
    assert.ok(t.sheet('月別').getRange('F6').getFormula().startsWith('=SPARKLINE(B6,'));
  });

  test('月別：機器別・業者別の導入数の合計が導入数と同じ', () => {
    const sh = t.sheet('月別');
    const head = sh.getRange(5, 1, 1, sh.getLastColumn()).getValues()[0];
    const rows = sh.getRange(6, 1, sh.getLastRow() - 5, head.length).getValues();
    const iDev = head.indexOf('AirSense10');
    const iSup = head.indexOf('フクダライフテック');
    const nDev = head.indexOf('', iDev) - iDev;
    rows.forEach(r => {
      const devSum = r.slice(iDev, iDev + nDev).reduce((a, b) => a + b, 0);
      const supSum = r.slice(iSup).reduce((a, b) => a + (b === '' ? 0 : b), 0);
      assert.strictEqual(devSum, r[1], r[0] + ' 機器別');
      assert.strictEqual(supSum, r[1], r[0] + ' 業者別');
    });
  });

  test('週別：すべての週（月曜はじまり）', () => {
    const exp = expectedWeeks(patients);
    const got = tableByLabel(t, '週別', 6, 5);
    assert.deepStrictEqual(Object.keys(got).length, Object.keys(exp).length);
    for (const k of Object.keys(exp)) {
      assert.ok(got[k], '週がない: ' + k);
      assert.deepStrictEqual([got[k][1], got[k][2], got[k][4]], [exp[k].intro, exp[k].exit, exp[k].active], k);
    }
    assert.strictEqual(t.values('週別', 'A6')[0][0], '2026/09/28〜10/04');
  });

  test('年別：年ごとの数字とグラフ', () => {
    const got = tableByLabel(t, '年別', 6, 5);
    for (const y of [2023, 2024, 2025, 2026]) {
      const s = Date.UTC(y, 0, 1);
      const e = Math.min(Date.UTC(y, 11, 31), TODAY);
      assert.deepStrictEqual([got[y + '年'][1], got[y + '年'][2], got[y + '年'][4]], [
        patients.filter(p => p.intro >= s && p.intro <= e).length,
        patients.filter(p => p.exit !== null && p.exit >= s && p.exit <= e).length,
        patients.filter(p => isActiveAt(p, e)).length], String(y));
    }
    const ch = t.sheet('年別').getCharts();
    assert.strictEqual(ch.length, 1);
    assert.strictEqual(ch[0].reversed, true);
  });

  test('機器別一覧：最初は「すべて・すべて・利用中」、選ぶと切り替わる', () => {
    assert.deepStrictEqual(t.values('機器別一覧', 'C3:G3')[0], ['すべて', 'すべて', 'すべて', '利用中', 'すべて']);
    const active = patients.filter(p => status(p) === '利用中');
    assert.strictEqual(t.sheet('機器別一覧').getLastRow() - 5, active.length + 1, '一覧＋注記1行');
    t.typeIn('機器別一覧', 'D3', 'AirSense10');
    t.typeIn('機器別一覧', 'E3', 'RISEF');
    const want = active.filter(p => p.device === 'AirSense10' && p.supplier === 'RISEF');
    const rows = t.values('機器別一覧', 'A6:M' + (5 + want.length));
    assert.deepStrictEqual(rows.map(r => r[0]), want.map(p => p.id).sort((a, b) => a - b));
    assert.ok(rows.every(r => r[3] === 'AirSense10' && r[4] === 'RISEF'));
    assert.ok(rows.every(r => r[2] === 'AirView'));
    gs.refreshNow();
    assert.deepStrictEqual(t.values('機器別一覧', 'C3:G3')[0], ['すべて', 'AirSense10', 'RISEF', '利用中', 'すべて'], '更新しても選択は残る');
    const p0 = want[0];
    const r0 = rows[0];
    assert.strictEqual(r0[11], (() => { const m = monthsBetween(p0.intro, TODAY); return m < 12 ? m + 'ヶ月' : Math.floor(m / 12) + '年' + (m % 12 ? m % 12 + 'ヶ月' : ''); })());
    // 対象を「○のみ」にすると、レポートを出す人と期間の一覧になる
    t.typeIn('機器別一覧', 'G3', '○のみ');
    const marked = want.filter(p => p.target);
    const mrows = marked.length ? t.values('機器別一覧', 'A6:M' + (5 + marked.length)) : [];
    assert.deepStrictEqual(mrows.map(r => r[0]), marked.map(p => p.id).sort((a, b) => a - b));
    assert.ok(mrows.every(r => r[6] === '○' && r[2] === 'AirView'));
    const head = t.values('機器別一覧', 'A5:M5')[0];
    assert.deepStrictEqual(head, ['ID', '名前', 'クラウド区分', '機器', '業者', '状態', '対象', 'レポート開始日', 'レポート終了日', '導入日', '最終通院日', '利用期間', '備考']);
    t.typeIn('機器別一覧', 'G3', 'すべて');
    t.typeIn('機器別一覧', 'D3', 'すべて');
    t.typeIn('機器別一覧', 'E3', 'すべて');
    // クラウドで選ぶ
    t.typeIn('機器別一覧', 'C3', 'InfoSmart');
    const infoSmart = patients.filter(p => status(p) === '利用中' && p.device === 'SleepStyle Auto Rx').length;
    assert.strictEqual(t.sheet('機器別一覧').getLastRow() - 5, infoSmart + (infoSmart ? 1 : 0));
    t.typeIn('機器別一覧', 'C3', 'すべて');
  });

  test('離脱分析：カード・理由別・期間別・一覧', () => {
    const exited = patients.filter(p => status(p) === '離脱');
    const v = t.values('離脱分析', 'A5:G5')[0];
    assert.strictEqual(v[0], exited.length);
    assert.strictEqual(v[1], exited.filter(p => ymd(p.exit)[0] === 2026).length);
    assert.strictEqual(v[3], exited.filter(p => p.exit < addMonths(p.intro, 3)).length);
    const head = t.find('離脱分析', '離脱理由別');
    const rows = t.values('離脱分析', `A${head[0] + 2}:D${head[0] + 8}`).filter(r => r[0] !== '');
    const count = r => exited.filter(p => (p.reason || '（未入力）') === r).length;
    rows.forEach(r => assert.strictEqual(r[1], count(r[0]), r[0]));
    assert.strictEqual(rows.reduce((a, r) => a + r[1], 0), exited.length);
    const lst = t.find('離脱分析', '離脱した人の一覧（新しい順）');
    const first = t.values('離脱分析', `A${lst[0] + 2}:G${lst[0] + 2}`)[0];
    const latest = exited.slice().sort((a, b) => b.exit - a.exit)[0];
    assert.strictEqual(t.ymdOf(first[1]), fmt(latest.exit));
    assert.strictEqual(t.sheet('離脱分析').getCharts().length, 1);
  });

  test('台数・費用：料金を入れると先月・今月の台数と金額が出る', () => {
    const m = t.sheet('マスタ');
    const v = m.getRange(5, 1, 9, 7).getValues();
    v.forEach(r => {
      const c = COMBOS.find(x => x[0] === r[0] && x[1] === r[1]);
      if (c) r[4] = c[2];
    });
    m.getRange(5, 1, 9, 7).setValues(v);
    gs.onEdit({ range: m.getRange('E5') });
    gs.refreshNow();
    const rows = t.values('台数・費用', 'A6:H20');
    const sep = { s: Date.UTC(2026, 8, 1), e: Date.UTC(2026, 8, 30) };
    const oct = { s: Date.UTC(2026, 9, 1), e: Date.UTC(2026, 9, 31) };
    const used = (p, M) => p.intro <= M.e && p.intro <= TODAY && (p.exit === null || p.exit > M.s);
    for (const c of COMBOS) {
      const r = rows.find(x => x[0] === c[0] && x[1] === c[1]);
      const mine = patients.filter(p => p.device === c[0] && p.supplier === c[1]);
      const bill = M => mine.filter(p => used(p, M) && !(c[3] && p.intro >= M.s && p.intro <= M.e)).length;
      assert.deepStrictEqual([r[4], r[5], r[6], r[7]], [bill(sep), bill(sep) * c[2], bill(oct), bill(oct) * c[2]], c.join('/'));
    }
    const noPrice = rows.find(x => x[0] === 'AirMini' && x[1] === 'RISEF');
    assert.strictEqual(noPrice[5], '', '料金がない組み合わせは金額が空');
  });

  test('集計タブに名前が出ない（機器別一覧を除く）', () => {
    for (const name of ['ダッシュボード', '月別', '週別', '年別', '離脱分析', '台数・費用']) {
      assert.ok(!sheetContains(t, name, '患者0'), name + ' に名前がある');
    }
    gs.makeAnonymousSheet();
    assert.ok(!sheetContains(t, '匿名データ', '患者0'));
    assert.strictEqual(t.sheet('匿名データ').getLastRow(), 4 + 400);
  });

  test('入力チェック：問題のある行を見つけ、行番号のリンクを付ける', () => {
    const sh = t.sheet('患者一覧');
    sh.getRange('C10').setValue('');                       // 機器が空欄
    sh.getRange('A12').setValue(10);                       // IDの重複（11行目と同じ10番）
    sh.getRange('K20').setValue(t.cellDate(2020, 1, 1));   // 離脱日が導入日より前
    sh.getRange('I30').setValue('きのう?');                 // 日付として読めない
    sh.getRange('A402:D402').setValues([[999, '', 'AirMini', 'RISEF']]);   // 名前がない行
    sh.getRange('C40').setValue('NewDevice');              // マスタにない機器
    sh.getRange('F60').setValue(t.cellDate(2026, 10, 1));  // 通院した当日：開始日＝今日・終了日＝昨日 → エラーにしない
    sh.getRange('G60').setFormula('=TODAY()-1');
    sh.getRange('F61:G61').setValues([[t.cellDate(2026, 10, 1), t.cellDate(2026, 9, 29)]]);   // 2日前 → エラー
    const exRow = 2 + patients.findIndex(p => status(p) === '離脱');
    sh.getRange('H' + exRow).setValue('○');               // 離脱しているのに○
    gs.refreshNow();
    const label = text => {
      const pos = t.find('ダッシュボード', text);
      assert.ok(pos, text + ' が出ていない');
      return t.values('ダッシュボード', 'D' + pos[0])[0][0];
    };
    assert.strictEqual(label('機器が空欄'), '1件');
    assert.strictEqual(label('IDが重複している'), '2件');
    assert.strictEqual(label('離脱日が導入日より前'), '1件');
    assert.strictEqual(label('レポート終了日が開始日より前'), '1件');
    assert.strictEqual(label('日付として読めない値がある'), '1件');
    assert.strictEqual(label('名前が空欄の行（ほかの欄には入力あり）'), '1件');
    assert.strictEqual(label('［マスタ］にない機器'), '1件');
    const all = t.values('患者一覧', 'A2:N402').filter(r => r[1] !== '');
    const noPeriod = all.filter(r => r[7] === '○' && (r[5] === '' || r[6] === '')).length;
    const exitedMarked = all.filter(r => r[7] === '○' && r[12] === '離脱').length;
    assert.ok(noPeriod > 0 && exitedMarked > 0);
    assert.strictEqual(label('対象（○）なのにレポート期間が空欄'), noPeriod + '件');
    assert.strictEqual(label('離脱しているのに対象（○）が付いている'), exitedMarked + '件');
    const pos = t.find('ダッシュボード', 'IDが重複している');
    const cell = t.sheet('ダッシュボード')._cell(pos[0], 5);
    const gid = t.sheet('患者一覧').getSheetId();
    assert.ok(cell.rich._links.some(l => l.url === `#gid=${gid}&range=A11`), 'リンク');
    assert.ok(cell.rich._text.includes('11行目(ID 10)、12行目(ID 10)'), cell.rich._text);
    assert.ok(t.sheet('ダッシュボード')._rowHeights[pos[0]] >= 22);
  });

  test('集計のときに、対象の書き方を○か空欄にそろえる（TRUE・x など）', () => {
    const sh = t.sheet('患者一覧');
    sh.getRange('H50').setValue(true);
    sh.getRange('H51').setValue('x');
    gs.refreshNow();
    assert.deepStrictEqual(t.values('患者一覧', 'H50:H51'), [['○'], ['']]);
  });

  test('自動更新：変更がなければ何もしない／変更があれば集計し直す', () => {
    let n = 0;
    const real = gs.refreshAll_;
    gs.refreshAll_ = function (o) { n++; return real(o); };
    gs.autoRefresh();
    assert.strictEqual(n, 0, '変更なし');
    t.sheet('患者一覧').getRange('L2').setValue('メモを追加');
    gs.autoRefresh();
    assert.strictEqual(n, 1, '変更あり');
    gs.autoRefresh();
    assert.strictEqual(n, 1, 'もう一度は呼ばない');
    gs.refreshAll_ = real;
  });

  test('自動更新：ほかの更新中なら飛ばす', () => {
    t.state.locks.script = true;
    const r = gs.refreshAll_({ wait: 10 });
    assert.strictEqual(r.skipped, true);
    t.state.locks.script = false;
  });

  test('外部連携：getPatientsForBatch の形', () => {
    const list = gs.getPatientsForBatch();
    const p = list.find(x => x.id === 1);
    assert.deepStrictEqual(Object.keys(p).sort(), ['cloud', 'days_to_next', 'end_date', 'exit_date', 'id', 'intro_date', 'kind',
      'last_visit', 'months_no_visit', 'name', 'next_due', 'other', 'reason', 'start_date', 'status', 'supplier', 'target'].sort());
    const withMark = patients.find(q => q.target && q.repStart !== null);
    const b = list.find(x => x.name === withMark.name);
    assert.strictEqual(b.target, 'TRUE');
    assert.strictEqual(b.start_date, '2026/09/01');
    assert.strictEqual(b.last_visit, fmt(withMark.visit));
    const noMark = patients.find(q => !q.target && q.repStart !== null);
    assert.strictEqual(list.find(x => x.name === noMark.name).target, 'FALSE', '期間があっても○がなければ対象外');
  });

  test('もう一度セットアップしてもデータは消えず、保護や規則が重ならない', () => {
    const before = t.values('患者一覧', 'A2:N401');
    const cf = t.sheet('患者一覧').getConditionalFormatRules().length;
    gs.setup();
    assert.deepStrictEqual(t.values('患者一覧', 'A2:N401'), before);
    assert.strictEqual(t.sheet('患者一覧').getConditionalFormatRules().length, cf);
    assert.strictEqual(t.sheet('患者一覧').getProtections('RANGE').length, 1);
    assert.strictEqual(t.sheet('ダッシュボード').getProtections('SHEET').length, 1);
    assert.strictEqual(t.state.triggers.length, 1);
    assert.strictEqual(t.values('マスタ', 'E5')[0][0], 1100, '料金も残る');
  });

  test('タブ名を変えられても目印で見つけて戻す', () => {
    t.sheet('患者一覧').setName('患者一覧2');
    gs.refreshNow();
    assert.ok(t.ss.getSheetByName('患者一覧'));
    assert.ok(!t.ss.getSheetByName('患者一覧2'));
  });

  test('見出しを消されたら、分かりやすいエラーを出す', () => {
    t.sheet('患者一覧').getRange('I1').setValue('導入');
    const before = t.state.alerts.length;
    gs.refreshNow();
    const a = t.state.alerts[before];
    assert.ok(a && a.prompt.includes('「導入日」の列が見つかりません'), a && a.prompt);
    t.sheet('患者一覧').getRange('I1').setValue('導入日');
    gs.autoRefresh();   // 自動更新は例外を出さない
  });

  test('自動更新のオン・オフ（何度押しても1つだけ）', () => {
    gs.disableAutoRefresh();
    assert.strictEqual(t.state.triggers.length, 0);
    assert.ok(t.state.alerts[t.state.alerts.length - 1].prompt.includes('オフにしました'));
    gs.disableAutoRefresh();
    assert.ok(t.state.alerts[t.state.alerts.length - 1].prompt.includes('設定されていませんでした'));
    gs.enableAutoRefresh();
    gs.enableAutoRefresh();
    assert.strictEqual(t.state.triggers.length, 1);
    assert.strictEqual(t.state.triggers[0]._t.minutes, 10);
  });

  test('使い方タブ：見出しと説明', () => {
    assert.ok(t.find('使い方', 'CPAP 患者管理 ─ 使い方'));
    assert.ok(sheetContains(t, '使い方', 'レポート（期間・対象○）をまとめて入力'));
    assert.ok(sheetContains(t, '使い方', '対象（○）をすべて消す'));
  });

  test('サイドバーを開ける（テンプレートの値が入る）', () => {
    gs.openReportForm();
    const html = t.state.sidebars[t.state.sidebars.length - 1];
    assert.ok(html._html.includes('data-panel="report"'));
    assert.strictEqual(html._title, 'CPAP管理');
  });

  finish();
}

// =====================================================================
// シナリオ：旧バージョン（v17）からの取り込み
// =====================================================================
function scenarioImport() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;
  // 旧ALL（v17 の列構成。ARRAYFORMULA の列は値として入っている想定）
  const all = t.ss.insertSheet('ALL');
  const head = ['管理ID', '名前', 'CPAP機種', '仕入先', '導入日', '最終通院日', '離脱日', 'その他', '次回予定日',
                'クラウド区分', '開始日', '終了日', '対象', '状態', '導入年'];
  const d = (y, m, dd) => t.cellDate(y, m, dd);
  const rows = [
    [101, '旧 太郎', 'AirSense10', 'フクダライフテック', d(2024, 5, 10), d(2026, 8, 1), '', '', d(2026, 11, 1), 'AirView', d(2026, 8, 1), d(2026, 9, 30), '○', '利用中', 2024],
    [102, '旧 花子', 'SleepStyle Auto Rx', 'チェスト|SleepStyle Auto Rx', d(2023, 2, 1), '', d(2025, 3, 31), '他院へ移管', '', 'InfoSmart', '', '', '○', '移管', 2023],
    [103, '旧 一郎', 'ムラタMX', 'チェスト', d(2025, 1, 15), '', d(2025, 2, 1), '', '', 'CSC', '', '', '', '離脱', 2025],
    ['', '旧 次郎', 'SBOX', 'RISEF', '2026/7/7', '', '', '', '', 'SEFAM', '', '', true, '利用中', 2026],
    [105, '旧 三郎', 'DreamStation', 'フィリップス', d(2026, 9, 1), '', '', '', '', '', '', '', '', '予定', 2026],
    [106, '旧 四郎', 'AirMini', '新しい業者', d(2025, 6, 1), '', '', '', '', '', '', '', '', '利用中', 2025],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  ];
  all.getRange(1, 1, 1, head.length).setValues([head]);
  all.getRange(2, 1, rows.length, head.length).setValues(rows);
  all.getRange('L2').setFormula('=TODAY()-1');
  all._cells.get('2,12').cached = d(2026, 9, 30);
  // 旧「設定」（B4:G4 機種マスタ、I4:Q4 料金マスタ）
  const cfg = t.ss.insertSheet('設定');
  cfg.getRange('B4:G4').setValues([['CPAP機種', '既定のクラウド区分', 'メーカー等', '既定仕入先', '使用中', '備考']]);
  cfg.getRange('B5:G6').setValues([['AirSense10', 'AirView', 'ResMed', 'RISEF', '○', ''],
                                  ['ムラタMX', 'CSC', '村田製作所／チェスト', 'チェスト', '○', '初月無料']]);
  cfg.getRange('I4:Q4').setValues([['料金キー', '仕入先', 'CPAP機種', '税抜月額', '税込月額', '月額収入', '初月無料', '税計算チェック', '備考']]);
  cfg.getRange('I5:Q7').setValues([
    ['フクダライフテック|AirSense10', 'フクダライフテック', 'AirSense10', 1000, 1100, '', 'なし', 'OK', 'テスト料金'],
    ['チェスト|ムラタMX', 'チェスト', 'ムラタMX', 2000, '', '', 'あり', '', ''],
    ['RISEF|AirMini', 'RISEF', 'AirMini', '', '', '', 'なし', '単価未入力', '追加分']]);
  // 旧バージョンの毎日トリガー
  t.gs.ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(7).everyDays(1).create();

  test('setup：旧ALLを見つけて取り込むか聞き、取り込む', () => {
    gs.setup();
    const ask = t.state.alerts.find(a => a.title === '旧データの取り込み');
    assert.ok(ask, '取り込みの確認が出ていない');
    const v = t.values('患者一覧', 'A2:N7');
    assert.strictEqual(v.length, 6);
    const by = {};
    v.forEach(r => { by[r[1]] = r; });
    assert.deepStrictEqual([by['旧 太郎'][0], by['旧 太郎'][3], by['旧 太郎'][12], t.ymdOf(by['旧 太郎'][6]), by['旧 太郎'][7]],
      [101, 'フクダライフテック', '利用中', '2026/09/30', '○'], '対象の○も取り込む');
    assert.deepStrictEqual([by['旧 花子'][3], by['旧 花子'][12], by['旧 花子'][13], by['旧 花子'][11], by['旧 花子'][7]],
      ['チェスト', '離脱', '移管・転院', '他院へ移管', ''], '離脱した人は○を外す');
    assert.deepStrictEqual([by['旧 一郎'][12], by['旧 一郎'][13]], ['離脱', '不明']);
    assert.strictEqual(by['旧 次郎'][0], 107, 'IDがない人は続きの番号');
    assert.strictEqual(t.ymdOf(by['旧 次郎'][8]), '2026/07/07', '文字の日付も日付に');
    assert.strictEqual(by['旧 次郎'][7], '○', '旧バージョンのチェックボックス（TRUE）も○に');
    assert.strictEqual(by['旧 三郎'][12], '利用中', '「予定」は利用中に');
    assert.strictEqual(t.ymdOf(by['旧 太郎'][9]), '2026/08/01', '最終通院日も取り込む');
    const taroRow = 2 + v.findIndex(r => r[1] === '旧 太郎');
    assert.strictEqual(t.sheet('患者一覧').getRange('G' + taroRow).getFormula(), '=TODAY()-1', '終了日の「いつも昨日」の式もそのまま');
    assert.strictEqual(t.state.triggers.length, 1, '旧トリガーは消して新しいものだけ');
    assert.strictEqual(t.state.triggers[0].getHandlerFunction(), 'autoRefresh');
  });

  test('取り込み：旧「設定」の料金と、データにある組み合わせがマスタに入る', () => {
    const m = t.values('マスタ', 'A5:G20').filter(r => r[0] !== '');
    const row = (dv, sp) => m.find(r => r[0] === dv && r[1] === sp);
    assert.strictEqual(row('AirSense10', 'フクダライフテック')[4], 1100);
    assert.strictEqual(row('AirSense10', 'フクダライフテック')[6], 'テスト料金');
    assert.strictEqual(row('ムラタMX', 'チェスト')[4], 2200, '税込がなければ税抜×1.1');
    assert.strictEqual(row('ムラタMX', 'チェスト')[5], 'あり');
    assert.strictEqual(row('AirMini', 'RISEF')[4], '');
    const added = row('AirMini', '新しい業者');
    assert.ok(added && added[6].includes('旧データから自動追加'));
    assert.ok(t.sheet('患者一覧').getRange('D2').getDataValidation().crit.list.includes('新しい業者'));
  });

  test('取り込み：旧ALLはそのまま、もう一度実行しても重ならない', () => {
    assert.strictEqual(t.values('ALL', 'B2')[0][0], '旧 太郎');
    assert.strictEqual(t.sheet('ALL').getRange('L2').getFormula(), '=TODAY()-1');
    gs.importOldData();
    const a = t.state.alerts.filter(x => x.title === '旧データの取り込み').pop();
    assert.ok(a.prompt.includes('0人を'), a.prompt);
    assert.ok(a.prompt.includes('6人は飛ばします'), a.prompt);
    assert.strictEqual(t.sheet('患者一覧').getLastRow(), 7);
  });

  test('旧タブを非表示にする（新しいタブは残す）', () => {
    t.ss.insertSheet('AirSense10（RISEF）').getRange('A1').setFormula('=IFERROR(FILTER(ALL!A2:Z,ALL!C2:C="AirSense10"),"")');
    t.ss.insertSheet('集計');
    t.ss.insertSheet('自分用メモ');
    gs.hideOldTabs();
    const hidden = t.ss.getSheets().filter(s => s.isSheetHidden()).map(s => s.getName()).sort();
    assert.deepStrictEqual(hidden, ['AirSense10（RISEF）', 'ALL', '設定', '集計'].sort());
    assert.ok(!t.sheet('自分用メモ').isSheetHidden());
    assert.ok(!t.sheet('ダッシュボード').isSheetHidden());
  });

  test('取り込み後の集計：移管は離脱理由「移管・転院」として数える', () => {
    gs.refreshNow();
    const pos = t.find('離脱分析', '移管・転院');
    assert.ok(pos);
    assert.strictEqual(t.values('離脱分析', 'B' + pos[0])[0][0], 1);
  });

  finish();
}

// =====================================================================
// シナリオ：v2.0（対象の列がない患者一覧）からの更新
// =====================================================================
function scenarioUpgrade() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;
  const d = (y, m, dd) => t.cellDate(y, m, dd);
  const sh = t.ss.insertSheet('患者一覧');
  sh.addDeveloperMetadata('cpapApp', 'ledger');
  sh.getRange(1, 1, 1, 11).setValues([['ID', '名前', '機器', '業者', 'レポート開始日', 'レポート終了日', '導入日', '離脱日',
    '備考', '状態', '離脱理由']]);
  sh.getRange(2, 1, 2, 11).setValues([
    [1, '前版 太郎', 'SBOX', 'RISEF', d(2026, 9, 1), d(2026, 9, 30), d(2025, 1, 10), '', 'メモ', '利用中', ''],
    [2, '前版 花子', 'AirMini', 'RISEF', '', '', d(2024, 3, 3), d(2025, 5, 5), '', '離脱', '自己中断']]);
  test('セットアップすると「対象」がレポート終了日の右に入り、データはそのまま', () => {
    gs.setup();
    assert.deepStrictEqual(t.display('患者一覧', 'A1:N1')[0],
      ['ID', '名前', '機器', '業者', 'クラウド区分', 'レポート開始日', 'レポート終了日', '対象', '導入日', '最終通院日', '離脱日', '備考', '状態', '離脱理由']);
    const v = t.values('患者一覧', 'A2:N3');
    assert.deepStrictEqual([v[0][1], v[0][7], t.ymdOf(v[0][8]), v[0][9], v[0][11], v[0][12]], ['前版 太郎', '', '2025/01/10', '', 'メモ', '利用中']);
    assert.deepStrictEqual([v[1][1], t.ymdOf(v[1][10]), v[1][12], v[1][13]], ['前版 花子', '2025/05/05', '離脱', '自己中断']);
    assert.ok(t.sheet('患者一覧').getRange('H2').getDataValidation().crit.list.includes('○'));
    assert.strictEqual(t.values('ダッシュボード', 'A5')[0][0], 1);
  });
  finish();
}

// =====================================================================
// シナリオ：最終通院日の列がない版で旧ALLを取り込みずみ → セットアップで最終通院日を入れる
// =====================================================================
function scenarioRefill() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;
  const d = (y, m, dd) => t.cellDate(y, m, dd);
  const all = t.ss.insertSheet('ALL');
  all.getRange(1, 1, 1, 8).setValues([['管理ID', '名前', 'CPAP機種', '仕入先', '導入日', '最終通院日', '開始日', '終了日']]);
  all.getRange(2, 1, 5, 8).setValues([
    [1, '前版 太郎', 'SBOX', 'RISEF', d(2025, 1, 10), d(2026, 9, 5), d(2026, 9, 5), ''],
    [2, '前版 花子', 'AirMini', 'RISEF', d(2024, 3, 3), d(2026, 8, 20), d(2026, 8, 20), ''],
    [3, '別人 三郎', 'SBOX', 'RISEF', d(2025, 2, 2), d(2026, 9, 9), d(2026, 9, 9), ''],
    [4, '前版 四郎', 'SBOX', 'RISEF', d(2025, 4, 4), '', '', ''],
    [5, '新規 五郎', 'SBOX', 'RISEF', d(2026, 9, 1), d(2026, 9, 1), d(2026, 9, 1), '']]);
  ['H2', 'H3', 'H4', 'H6'].forEach(a => all.getRange(a).setFormula('=TODAY()-1'));
  // 前の版で 9/29 に取り込んだ患者一覧（最終通院日の列がなく、終了日の式はそのときの日付になっている）
  const sh = t.ss.insertSheet('患者一覧');
  sh.addDeveloperMetadata('cpapApp', 'ledger');
  sh.getRange(1, 1, 1, 13).setValues([['ID', '名前', '機器', '業者', 'クラウド区分', 'レポート開始日', 'レポート終了日', '対象',
    '導入日', '離脱日', '備考', '状態', '離脱理由']]);
  sh.getRange(2, 1, 4, 13).setValues([
    [1, '前版 太郎', 'SBOX', 'RISEF', 'SEFAM', d(2026, 9, 5), d(2026, 9, 28), '○', d(2025, 1, 10), '', '', '利用中', ''],
    [2, '前版 花子', 'AirMini', 'RISEF', 'AirView', d(2026, 9, 1), d(2026, 9, 30), '○', d(2024, 3, 3), '', '', '利用中', ''],
    [3, '前版 三郎', 'SBOX', 'RISEF', 'SEFAM', d(2026, 9, 9), d(2026, 9, 28), '', d(2025, 2, 2), '', '', '利用中', ''],
    [4, '前版 四郎', 'SBOX', 'RISEF', 'SEFAM', '', '', '', d(2025, 4, 4), '', '', '利用中', '']]);

  test('セットアップで、空欄の最終通院日を旧ALLから入れる（期間が取り込んだときのままなら終了日も式に）', () => {
    gs.setup();
    const ask = t.state.alerts.find(a => a.title === '最終通院日の取り込み');
    assert.ok(ask, '確認が出ていない');
    assert.ok(ask.prompt.includes('2人に旧データの最終通院日（うち 1人はレポート終了日を「いつも昨日」の式に戻す）'), ask.prompt);
    assert.ok(!t.state.alerts.some(a => a.title === '旧データの取り込み'), '患者がいるときは、全体の取り込みは聞かない');
    const ledger = t.sheet('患者一覧');
    assert.strictEqual(t.display('患者一覧', 'J1')[0][0], '最終通院日');
    assert.deepStrictEqual(t.display('患者一覧', 'F2:J5'), [
      ['2026/09/05', '2026/09/30', '○', '2025/01/10', '2026/09/05'],
      ['2026/09/01', '2026/09/30', '○', '2024/03/03', '2026/08/20'],
      ['2026/09/09', '2026/09/28', '', '2025/02/02', ''],
      ['', '', '', '2025/04/04', '']]);
    assert.strictEqual(ledger.getRange('G2').getFormula(), '=TODAY()-1', '期間が取り込んだときのままなら式に戻す');
    assert.strictEqual(ledger.getRange('G3').getFormula(), '', '期間を変えた人は終了日をそのまま');
    assert.strictEqual(ledger.getRange('G4').getFormula(), '', 'ID が同じでも名前が違う人には入れない');
    assert.strictEqual(ledger.getLastRow(), 5, 'セットアップでは新しい人は足さない');
    const done = t.state.alerts.find(a => a.title === 'セットアップ完了');
    assert.ok(done.prompt.includes('最終通院日が空欄だった 2人に、旧データの最終通院日を入れました。'), done.prompt);
    assert.ok(!done.prompt.includes('人を取り込みました'), done.prompt);
  });

  test('もう一度セットアップしても聞かない／取り込みメニューでは、いない人だけを足す', () => {
    const n = t.state.alerts.length;
    gs.setup();
    assert.ok(!t.state.alerts.slice(n).some(a => a.title === '最終通院日の取り込み'));
    gs.importOldData();
    const a = t.state.alerts.filter(x => x.title === '旧データの取り込み').pop();
    assert.ok(a.prompt.includes('1人を') && a.prompt.includes('4人は飛ばします'), a.prompt);
    assert.ok(!a.prompt.includes('旧データの最終通院日'), a.prompt);
    assert.deepStrictEqual(t.display('患者一覧', 'B6:J6')[0],
      ['新規 五郎', 'SBOX', 'RISEF', 'SEFAM', '2026/09/01', '2026/09/30', '', '2026/09/01', '2026/09/01']);
    assert.strictEqual(t.sheet('患者一覧').getRange('G6').getFormula(), '=TODAY()-1');
  });

  test('取り込みメニューからも、空欄の最終通院日を入れられる', () => {
    t.sheet('患者一覧').getRange('J3').clearContent();
    gs.importOldData();
    const a = t.state.alerts.filter(x => x.title === '旧データの取り込み').pop();
    assert.ok(a.prompt.includes('0人を') && a.prompt.includes('1人に旧データの最終通院日を入れます。'), a.prompt);
    assert.strictEqual(t.display('患者一覧', 'J3')[0][0], '2026/08/20');
    assert.strictEqual(t.sheet('患者一覧').getRange('G3').getFormula(), '', '期間を変えた人は終了日をそのまま');
    const done = t.state.alerts.filter(x => x.title === '取り込み完了').pop();
    assert.ok(done.prompt.includes('最終通院日が空欄だった 1人に'), done.prompt);
  });
  finish();
}

// =====================================================================
// シナリオ：同じ名前のシートがすでにある
// =====================================================================
function scenarioCollision() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;
  t.ss.insertSheet('ダッシュボード').getRange('A1').setValue('自分で作った表');
  t.ss.insertSheet('マスタ').getRange('A1').setValue('別の用途');
  test('同じ名前の自分のシートは「（旧）」を付けて残す', () => {
    gs.setup();
    assert.strictEqual(t.values('ダッシュボード（旧）', 'A1')[0][0], '自分で作った表');
    assert.strictEqual(t.values('マスタ（旧）', 'A1')[0][0], '別の用途');
    assert.strictEqual(t.values('ダッシュボード', 'A1')[0][0], 'CPAP 患者管理ダッシュボード');
  });
  test('患者がいなくても集計タブが作れる', () => {
    assert.ok(t.find('ダッシュボード', '患者がまだいません'));
    assert.ok(t.find('月別', '導入日が入った利用者がまだいません。'));
    assert.ok(t.find('機器別一覧', '該当する人はいません'));
    assert.ok(t.find('ダッシュボード', '✓ 問題は見つかりませんでした'));
  });
  test('1人だけ（導入日なし）でも動く', () => {
    t.typeIn('患者一覧', 'B2', 'ひとり');
    gs.refreshNow();
    assert.ok(t.find('ダッシュボード', '導入日が空欄'));
    assert.ok(t.find('ダッシュボード', '機器が空欄'));
    t.typeIn('患者一覧', 'I2', 't');
    t.typeIn('患者一覧', 'C2', 'DreamStation');
    gs.refreshNow();
    assert.strictEqual(t.values('月別', 'B6')[0][0], 1);
    assert.strictEqual(t.values('週別', 'A6')[0][0], '2026/09/28〜10/04');
  });
  finish();
}

// =====================================================================
// シナリオ：人数が多いとき（3,000人）
// =====================================================================
function scenarioBig() {
  const t = load({ sheetTz: sheetTzArg });
  const gs = t.gs;
  gs.setup();
  const patients = makePatients(3000, 99);
  test('3,000人でも集計できる', () => {
    writeLedger(t, patients);
    const t0 = Date.now();
    gs.refreshNow();
    const ms = Date.now() - t0;
    assert.ok(t.lastToast().includes('3000人'), t.lastToast());
    const exp = expectedMonths(patients);
    assert.strictEqual(t.values('月別', 'E6')[0][0], exp['2026/10'].active);
    console.log(`    （モック上の集計時間：${ms}ms）`);
  });
  test('貼り付けが300行を超えたら入力時の処理は飛ばし、集計のときに整える', () => {
    const more = makePatients(350, 5).map((p, i) => Object.assign(p, { id: '', name: '追加' + i, intro: Date.UTC(2026, 8, 15), exit: null }));
    const d = ms => (ms === null ? '' : t.cellDate(...ymd(ms)));
    const rows = more.map(p => ['', p.name, p.device, p.supplier, '', '', '', '', d(p.intro), '', '', '', '', '']);
    t.paste('患者一覧', 3002, 1, rows);
    assert.strictEqual(t.values('患者一覧', 'A3002')[0][0], '');
    gs.refreshNow();
    assert.strictEqual(t.values('患者一覧', 'A3002')[0][0], 3001);
    assert.strictEqual(t.values('患者一覧', 'M3351')[0][0], '利用中');
    const sh = t.sheet('患者一覧');
    assert.ok(sh.getRange(3351, 3).getDataValidation(), '増えた行にもドロップダウン');
  });
  finish();
}

// =====================================================================
// シナリオ：スクリプトとシートのタイムゾーンが違う
// =====================================================================
function scenarioTz() {
  const t = load({ sheetTz: sheetTzArg, now: '2026-10-01T10:00:00+09:00' });
  const gs = t.gs;
  gs.setup();
  test('t を入れると、シートのタイムゾーンでの今日の0時になる', () => {
    t.typeIn('患者一覧', 'B2', 'テスト');
    t.typeIn('患者一覧', 'I2', 't');
    const v = t.values('患者一覧', 'I2')[0][0];
    const p = require('./gas-mock').tzParts(new Date(t.nowMs), t.ss.getSpreadsheetTimeZone());
    assert.strictEqual(t.ymdOf(v), `${p.y}/${pad(p.m)}/${pad(p.d)}`);
    assert.ok(t.isMidnight(v));
  });
  test('登録した導入日がずれない', () => {
    gs.registerPatient({ name: 'TZ', device: 'SBOX', supplier: 'RISEF', intro: '2026-09-15', repStart: '2026-09-01', repEnd: '2026-09-30' });
    const all = t.values('患者一覧', 'F3:I3')[0];
    const v = [all[0], all[1], all[3]];
    assert.deepStrictEqual(v.map(t.ymdOf), ['2026/09/01', '2026/09/30', '2026/09/15']);
    assert.ok(v.every(t.isMidnight));
  });
  test('月の境目の日付が正しい月に入る', () => {
    const sh = t.sheet('患者一覧');
    sh.getRange('B4:K5').setValues([
      ['月末', 'SBOX', 'RISEF', '', '', '', '', t.cellDate(2026, 8, 31), '', ''],
      ['月初', 'SBOX', 'RISEF', '', '', '', '', t.cellDate(2026, 9, 1), '', t.cellDate(2026, 9, 30)]]);
    gs.refreshNow();
    const m = tableByLabel(t, '月別', 6, 5);
    // シートのタイムゾーンでの「今日」（LA ではまだ 9/30 なので、t で入れた人も9月になる）
    const today = require('./gas-mock').tzParts(new Date(t.nowMs), t.ss.getSpreadsheetTimeZone());
    assert.strictEqual(m['2026/08'][1], 1);
    assert.strictEqual(m['2026/09'][1], today.m === 9 ? 3 : 2);
    assert.strictEqual(m['2026/09'][2], 1);
    const v = t.values('患者一覧', 'I4:I5').map(r => t.ymdOf(r[0]));
    assert.deepStrictEqual(v, ['2026/08/31', '2026/09/01']);
  });
  test('レポート期間（前回の続き）もずれない', () => {
    t.select('患者一覧', ['A3']);
    gs.applyReportPeriod({ mode: 'continue', end: '2026-10-31' });
    assert.deepStrictEqual(t.values('患者一覧', 'F3:G3')[0].map(t.ymdOf), ['2026/10/01', '2026/10/31']);
  });
  finish();
}

({ main: scenarioMain, import: scenarioImport, upgrade: scenarioUpgrade, refill: scenarioRefill, collision: scenarioCollision,
   big: scenarioBig,
   tz: scenarioTz })[scenario]();
