/** @OnlyCurrentDoc */

/**
 * CPAP 患者管理 / Google スプレッドシート用スクリプト  v2.0
 * ------------------------------------------------------------
 * 入力するのは「患者一覧」と「マスタ」の2つのタブだけです。
 * ほかのタブ（ダッシュボード・月別・週別・年別・機器別一覧・離脱分析・台数・費用）は、
 * スクリプトが患者一覧から計算して作り直します。
 *
 *  【作りの方針】
 *   ・列は見出しの名前で探します（完全一致）。右に列を足しても動きます。
 *   ・集計タブには数式ではなく計算済みの値を書き込みます（#REF! などのエラーが出ません）。
 *   ・入力してから10分ほどで集計に反映されます（メニューの［集計を今すぐ更新］なら即時）。
 *   ・状態（利用中／離脱）は離脱日から自動で決まります。
 *   ・患者一覧とマスタに入力したデータを、スクリプトが消すことはありません。
 *
 * 最初に一度、メニュー［CPAP管理］→［管理・設定］→［初期セットアップ／修復］を実行してください。
 */

// ============================================================
// 設定
// ============================================================
var APP_VERSION = '2.0';
var APP_KEY = 'cpapApp';            // このスクリプトが作ったタブの目印（タブ名が変わっても見つけられる）
var AUTO_REFRESH_MINUTES = 10;      // 自動更新の間隔（1・5・10・15・30 のどれか）

var SH = {
  ledger: '患者一覧',
  dash:   'ダッシュボード',
  month:  '月別',
  week:   '週別',
  year:   '年別',
  device: '機器別一覧',
  exit:   '離脱分析',
  cost:   '台数・費用',
  master: 'マスタ',
  guide:  '使い方',
  anon:   '匿名データ'
};
var TAB_ORDER = ['ledger', 'dash', 'month', 'week', 'year', 'device', 'exit', 'cost', 'master', 'guide'];
var INPUT_TABS = { ledger: true, master: true };

var STATUS_ACTIVE = '利用中';
var STATUS_EXIT = '離脱';
var TARGET_MARK = '○';   // 対象の印（印刷してもそのまま読めるよう、チェックボックスではなく文字）
var NONE = '（未入力）';
var ALL_OPTION = 'すべて';

// 患者一覧の列（左から順）。見出しはこの名前で作り、この名前で探します。
var LEDGER = [
  { key: 'id', head: 'ID', width: 60,
    note: '名前を入れると自動で番号が入ります（IDがすべて数字のとき）。手で入れてもかまいません。' },
  { key: 'name', head: '名前', width: 120 },
  { key: 'device', head: '機器', width: 150, note: '［マスタ］タブにある機器から選びます。' },
  { key: 'supplier', head: '業者', width: 140,
    note: '機器を選ぶと、業者が1社だけの機器は自動で入ります。' },
  { key: 'cloud', head: 'クラウド区分', width: 130,
    note: '機器を選ぶと［マスタ］のクラウドが自動で入ります（AirView・InfoSmart など）。\n' +
          'マスタにクラウドがない機器のときだけ、手で入れてください。' },
  { key: 'repStart', head: 'レポート開始日', width: 105, date: true,
    note: 'レポートを出す期間の初日です。\n' +
          'まとめて入れるときは、行を選んでメニュー［CPAP管理］→［レポート期間をまとめて入力］。' },
  { key: 'repEnd', head: 'レポート終了日', width: 105, date: true, note: 'レポートを出す期間の最終日です。' },
  { key: 'target', head: '対象', width: 50,
    note: 'レポートを出す人に「○」を入れます（何を入れても○になります。×・0 は空欄に）。\n' +
          '空欄＝対象外です。離脱日を入れると空欄に戻ります。\n' +
          'まとめて付ける・外す：行を選んでメニュー［CPAP管理］→［レポート（期間・対象○）をまとめて入力］\n' +
          'すべて消す：メニュー［CPAP管理］→［対象（○）をすべて消す］' },
  { key: 'intro', head: '導入日', width: 100, date: true,
    note: 'CPAPを始めた日です。月別・週別の「導入数」はこの日で数えます。' },
  { key: 'exit', head: '離脱日', width: 100, date: true,
    note: 'CPAPをやめた日です。入れると「状態」が自動で「離脱」になります。\n' +
          '未来の日付なら、その日になったときに切り替わります。' },
  { key: 'note', head: '備考', width: 220 },
  { key: 'status', head: '状態', width: 70,
    note: '離脱日から自動で決まります（利用中／離脱）。\n離脱日を消すと「利用中」に戻ります。' },
  { key: 'reason', head: '離脱理由', width: 130,
    note: '離脱したときに選びます（離脱分析タブで使います）。\n候補は［マスタ］タブで変えられます。' }
];
var DATE_KEYS = ['repStart', 'repEnd', 'intro', 'exit'];
var LEDGER_MIN_ROWS = 2000;   // 患者一覧の最初の行数（足りなくなって下に行を足したら、次の集計で入力規則も広がる）
var HEAD = {};
LEDGER.forEach(function (c) { HEAD[c.key] = c.head; });

// マスタ：機器と業者の組み合わせを1行ずつ（同じ機器でも業者が違えば別の行）
var MASTER_HEAD = ['機器', '業者', 'メーカー', 'クラウド', '月額レンタル料（税込）', '初月無料', '備考'];
var MASTER_FIELDS = ['device', 'supplier', 'maker', 'cloud', 'price', 'free', 'note'];
var REASON_HEAD = '離脱理由の候補';
var REASON_COL = 9;   // I列
// 初期値（旧バージョンの設定より）。月額はここには入れていません：マスタに入力するか、旧データの取り込みで入ります。
var DEFAULT_COMBOS = [
  ['AirSense10',         'フクダライフテック', 'ResMed',          'AirView',          '', 'なし', ''],
  ['AirSense10',         'RISEF',             'ResMed',          'AirView',          '', 'なし', ''],
  ['AirMini',            'フクダライフテック', 'ResMed',          'AirView',          '', 'なし', ''],
  ['AirMini',            'RISEF',             'ResMed',          'AirView',          '', 'なし', ''],
  ['SleepStyle Auto Rx', 'チェスト',           'Fisher & Paykel', 'InfoSmart',        '', 'あり', ''],
  ['DreamStation',       'フィリップス',       'Philips',         'CareOrchestrator', '', 'なし', ''],
  ['ムラタMX',           'チェスト',           '村田製作所',       'CSC',              '', 'あり', ''],
  ['SBOX',               'RISEF',             'SEFAM',           'SEFAM',            '', 'なし', ''],
  ['SBOX（加湿器付）',    'RISEF',             'SEFAM',           'SEFAM',            '', 'なし', '']
];
var DEFAULT_REASONS = ['自己中断', '移管・転院', '経済的な理由', '症状の改善・不要', '他の治療へ変更',
                       '入院・施設入所', '死亡', 'その他', '不明'];
var REASON_MOVED = '移管・転院';
var REASON_UNKNOWN = '不明';

// 旧バージョン（v17まで）のシート
var OLD_ALL_NAMES = ['ALL'];
var OLD_CONFIG_NAMES = ['設定'];
var OLD_TABS = ['ALL', '設定', '集計', '作業リスト', 'コスト計算', '年別分析', '月別導入数', '週別導入数',
                '離脱者', '移管者', '分析用（匿名）', 'データチェック', '機器別詳細', 'コスト管理'];
var OLD_HEADERS = {
  id:       ['管理ID', 'ID', 'No', 'No.', '番号'],
  name:     ['名前', '氏名'],
  device:   ['CPAP機種', '機種', '種類', '機械の種類', '機器'],
  supplier: ['仕入先', '業者', '社名'],
  cloud:    ['クラウド区分', 'クラウド'],
  repStart: ['開始日', 'レポート開始日'],
  repEnd:   ['終了日', 'レポート終了日'],
  target:   ['対象'],
  intro:    ['導入日'],
  exit:     ['離脱日'],
  note:     ['その他', '備考'],
  status:   ['状態'],
  reason:   ['離脱理由']
};

// 色（旧バージョンと同じ配色）
var C_TITLE = '#1f3864';
var C_HEAD = '#1f4e79';
var C_SECTION = '#2e75b6';
var C_SUB = '#595959';
var C_INPUT = '#fffde7';
var C_CARD = '#eaf1fb';
var C_TOTAL = '#ddebf7';
var C_NOW = '#fff2cc';
var C_ALERT = '#f4c7c3';
var C_ALERT_FONT = '#9c0006';
var C_WARN = '#ffd9a8';
var C_WARN_FONT = '#9c5000';
var C_TODO = '#d9edf7';
var C_EXIT_BG = '#eeeeee';
var C_EXIT_FONT = '#8a8a8a';
var C_OK = '#e6f4ea';
var C_OK_FONT = '#17603a';
var C_BORDER = '#d9d9d9';
var C_BLUE = '#2e75b6';
var C_RED = '#c0504d';


// ============================================================
// メニュー・自動で動く入口
// ============================================================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('CPAP管理')
    .addItem('新規登録フォーム', 'openRegisterForm')
    .addItem('レポート（期間・対象○）をまとめて入力', 'openReportForm')
    .addItem('対象（○）をすべて消す', 'clearTargetMarks')
    .addSeparator()
    .addItem('集計を今すぐ更新', 'refreshNow')
    .addItem('匿名データを作る（外部での分析用）', 'makeAnonymousSheet')
    .addSeparator()
    .addSubMenu(ui.createMenu('管理・設定')
      .addItem('初期セットアップ／修復（何度実行してもOK）', 'setup')
      .addItem('旧バージョンのデータ（ALL・設定）を取り込む', 'importOldData')
      .addItem('旧バージョンのタブを非表示にする', 'hideOldTabs')
      .addSeparator()
      .addItem('自動更新をオンにする（' + AUTO_REFRESH_MINUTES + '分ごと）', 'enableAutoRefresh')
      .addItem('自動更新をオフにする', 'disableAutoRefresh'))
    .addToUi();
  if (!ss_().getSheetByName(SH.ledger)) {
    ss_().toast('メニュー［CPAP管理］→［管理・設定］→［初期セットアップ／修復］を実行してください。',
      'CPAP管理', 15);
  }
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var name = sh.getName();
    if (name === SH.ledger) onLedgerEdit_(e, sh);
    else if (name === SH.device) onDeviceSelectorEdit_(e);
    else if (name === SH.master) applyListRules_();
  } catch (err) {
    console.error(err);   // 自動処理が失敗しても、入力そのものは止めない
  }
}

function openRegisterForm() { showSidebar_('register'); }
function openReportForm() { showSidebar_('report'); }

function showSidebar_(panel) {
  var t = HtmlService.createTemplateFromFile('SidebarForm');
  t.panel = panel;
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('CPAP管理'));
}

function refreshNow() {
  withUi_(function () {
    ss_().toast('集計を更新しています…', 'CPAP管理', 60);
    var r = refreshAll_({ wait: 30000 });
    ss_().toast(r.skipped ? 'ほかの更新が実行中です。少し待ってからもう一度お試しください。'
                          : '集計を更新しました（' + r.patients + '人）。', 'CPAP管理', 5);
  });
}

function makeAnonymousSheet() {
  withUi_(function () {
    var ctx = loadContext_();
    writeAnonSheet_(ctx);
    ss_().setActiveSheet(ss_().getSheetByName(SH.anon));
    ss_().toast('匿名データを作りました（名前・備考は含みません）。集計の更新のたびに最新になります。',
      'CPAP管理', 8);
  });
}

/** メニューから呼ぶ処理を包み、エラーは画面に出す */
function withUi_(fn) {
  try {
    return fn();
  } catch (err) {
    var ui = SpreadsheetApp.getUi();
    ui.alert('CPAP管理', String((err && err.message) || err), ui.ButtonSet.OK);
  }
}

/** 設定の不足が原因のエラー（自動更新では静かに見送る） */
function configError_(message) {
  var e = new Error(message);
  e.name = 'ConfigError';
  return e;
}


// ============================================================
// 初期セットアップ／修復
// ============================================================
function setup() {
  withUi_(function () {
    var ui = SpreadsheetApp.getUi();
    var res = ui.alert('初期セットアップ／修復',
      'タブ・見出し・入力ルール（ドロップダウン）・色分けを整えます。\n' +
      '患者一覧とマスタに入力済みのデータは消えません。何度実行しても大丈夫です。\n\n実行しますか？',
      ui.ButtonSet.OK_CANCEL);
    if (res !== ui.Button.OK) return;

    var notes = [];
    ensureMaster_();
    ensureLedger_();
    TAB_ORDER.forEach(function (key) { if (!INPUT_TABS[key]) outputSheet_(key); });
    writeGuide_();
    applyLedgerRules_();
    arrangeTabs_();
    removeBlankDefaultSheet_();

    try {
      installAutoRefresh_();
      notes.push('・自動更新をオンにしました（' + AUTO_REFRESH_MINUTES + '分ごと）。');
    } catch (eTrig) {
      notes.push('・自動更新を設定できませんでした：' + eTrig.message);
    }

    if (countPatients_() === 0 && findOldSheet_(OLD_ALL_NAMES)) {
      var ans = ui.alert('旧データの取り込み',
        '旧バージョンの「ALL」シートが見つかりました。患者データを「' + SH.ledger + '」に取り込みますか？\n' +
        '（ALLシートは変更せず、そのまま残します）', ui.ButtonSet.YES_NO);
      if (ans === ui.Button.YES) notes.push('・' + runImport_(planImport_()).message);
    }

    var r = refreshAll_({ wait: 30000 });
    if (r.skipped) notes.push('・集計はほかの更新と重なったため、少しあとで自動更新されます。');
    var guide = ss_().getSheetByName(SH.guide);
    if (guide) ss_().setActiveSheet(guide);
    ui.alert('セットアップ完了', (notes.length ? notes.join('\n') + '\n\n' : '') +
      '「' + SH.guide + '」タブに説明があります。まず［' + SH.master + '］の機器・業者を確認してください。',
      ui.ButtonSet.OK);
  });
}

function ensureMaster_() {
  var sh = adoptOrCreate_('master', function (s) {
    var head = rowText_(s, 4);
    return head.indexOf(MASTER_HEAD[0]) >= 0 && head.indexOf(MASTER_HEAD[1]) >= 0;
  });
  if (sh.getLastRow() === 0) {
    ensureSize_(sh, 5 + Math.max(DEFAULT_COMBOS.length, DEFAULT_REASONS.length), REASON_COL);
    sh.getRange(4, 1, 1, MASTER_HEAD.length).setValues([MASTER_HEAD]);
    sh.getRange(5, 1, DEFAULT_COMBOS.length, MASTER_HEAD.length).setValues(DEFAULT_COMBOS);
    sh.getRange(4, REASON_COL).setValue(REASON_HEAD);
    sh.getRange(5, REASON_COL, DEFAULT_REASONS.length, 1)
      .setValues(DEFAULT_REASONS.map(function (x) { return [x]; }));
  } else if (rowText_(sh, 4).indexOf(REASON_HEAD) < 0 && sh.getRange(4, REASON_COL).getDisplayValue() === '') {
    ensureSize_(sh, 5 + DEFAULT_REASONS.length, REASON_COL);
    sh.getRange(4, REASON_COL).setValue(REASON_HEAD);
    sh.getRange(5, REASON_COL, DEFAULT_REASONS.length, 1)
      .setValues(DEFAULT_REASONS.map(function (x) { return [x]; }));
  }

  sh.setHiddenGridlines(true);
  sh.getRange('A1').setValue('マスタ（ここを直すと、患者一覧のドロップダウンと集計に反映されます）')
    .setFontSize(14).setFontWeight('bold').setFontColor(C_TITLE);
  sh.getRange('A2').setValue('機器と業者の組み合わせを1行ずつ入れます（同じ機器でも業者が違えば別の行）。' +
    '月額と初月無料を入れると「' + SH.cost + '」タブで金額の目安が出ます。').setFontSize(9).setFontColor(C_SUB);
  var head = rowText_(sh, 4);
  var last = Math.max(sh.getMaxRows(), 100);
  ensureSize_(sh, last, REASON_COL);
  MASTER_HEAD.forEach(function (h) {
    var col = head.indexOf(h) + 1;
    if (col) headStyle_(sh.getRange(4, col));
  });
  var rc = head.indexOf(REASON_HEAD) + 1;
  if (rc) {
    headStyle_(sh.getRange(4, rc));
    sh.getRange(5, rc, last - 4, 1).setBackground(C_INPUT);
    sh.setColumnWidth(rc, 160);
  }
  sh.getRange(5, 1, last - 4, MASTER_HEAD.length).setBackground(C_INPUT);
  var priceCol = head.indexOf(MASTER_HEAD[4]) + 1;
  if (priceCol) sh.getRange(5, priceCol, last - 4, 1).setNumberFormat('#,##0');
  var freeCol = head.indexOf(MASTER_HEAD[5]) + 1;
  if (freeCol) {
    sh.getRange(5, freeCol, last - 4, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['あり', 'なし'], true).setAllowInvalid(true).build()).setHorizontalAlignment('center');
  }
  [160, 150, 130, 140, 150, 80, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setColumnWidth(8, 24);
  sh.setFrozenRows(4);
  protectHeaderRow_(sh, 4, 'CPAP管理：マスタの見出し');
  return sh;
}

function ensureLedger_() {
  var sh = adoptOrCreate_('ledger', function (s) {
    var head = rowText_(s, 1);
    return head.indexOf(HEAD.name) >= 0 && head.indexOf(HEAD.intro) >= 0;
  });
  var head = rowText_(sh, 1);
  if (!head.some(function (h) { return h !== ''; })) {
    // 新しいシート：見出しを順番どおりに書く
    ensureSize_(sh, 2, LEDGER.length);
    sh.getRange(1, 1, 1, LEDGER.length).setValues([LEDGER.map(function (col) { return col.head; })]);
  } else {
    // 足りない列は本来の位置（ひとつ前の列のすぐ右）に差し込む。前の列がなければ右端に足す
    LEDGER.forEach(function (col, i) {
      head = rowText_(sh, 1);
      if (head.indexOf(col.head) >= 0) return;
      var after = 0;
      for (var j = i - 1; j >= 0 && !after; j--) after = head.indexOf(LEDGER[j].head) + 1;
      if (after) {
        sh.insertColumnAfter(after);
        sh.getRange(1, after + 1).setValue(col.head);
      } else {
        var last = sh.getLastColumn() + 1;
        ensureSize_(sh, 2, last);
        sh.getRange(1, last).setValue(col.head);
      }
    });
  }

  ensureSize_(sh, LEDGER_MIN_ROWS, 1);
  var c = ledgerCols_(sh);
  var n = sh.getMaxRows() - 1;
  headStyle_(sh.getRange(1, 1, 1, c.lastCol));
  sh.setRowHeight(1, 34);
  LEDGER.forEach(function (col) {
    var cell = sh.getRange(1, c[col.key]);
    if (col.note) cell.setNote(col.note); else cell.clearNote();
    sh.setColumnWidth(c[col.key], col.width);
    if (col.date) sh.getRange(2, c[col.key], n, 1).setNumberFormat('yyyy/mm/dd');
  });
  sh.getRange(2, c.id, n, 1).setHorizontalAlignment('center');
  sh.getRange(2, c.status, n, 1).setHorizontalAlignment('center');
  sh.getRange(2, c.target, n, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.setFrozenRows(1);
  if (c.name <= 3) sh.setFrozenColumns(c.name);
  return sh;
}

/** 患者一覧の入力ルール・色分け・フィルタ・見出しの保護 */
function applyLedgerRules_() {
  var sh = findSheet_('ledger');
  if (!sh) return;
  var c = ledgerCols_(sh);
  requireCols_(c);
  var n = sh.getMaxRows() - 1;
  applyListRules_();
  sh.getRange(2, c.target, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([TARGET_MARK], true).setAllowInvalid(true)
    .setHelpText('レポートを出す人に「○」（何を入れても○になります）').build());
  sh.getRange(2, c.status, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS_ACTIVE, STATUS_EXIT], true).setAllowInvalid(true).build());
  var dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true)
    .setHelpText('日付を入れてください（t＝今日、y＝昨日、20261001・R8.10.1 なども入ります）').build();
  DATE_KEYS.forEach(function (k) {
    sh.getRange(2, c[k], n, 1).setDataValidation(dateRule).setNumberFormat('yyyy/mm/dd');
  });
  sh.setConditionalFormatRules(ledgerFormatRules_(sh, c));

  var f = sh.getFilter();
  if (f && (f.getRange().getLastColumn() < c.lastCol || f.getRange().getLastRow() < sh.getMaxRows())) {
    f.remove();
    f = null;
  }
  if (!f) sh.getRange(1, 1, sh.getMaxRows(), c.lastCol).createFilter();
  protectHeaderRow_(sh, 1, 'CPAP管理：患者一覧の見出し（名前を変えると集計できなくなります）');
  PropertiesService.getDocumentProperties().setProperty('ledgerRows', String(sh.getMaxRows()));
}

/** 機器・業者・離脱理由のドロップダウンをマスタに合わせる（マスタを編集したときにも動く） */
function applyListRules_() {
  var sh = findSheet_('ledger');
  if (!sh) return;
  var c = ledgerCols_(sh);
  if (c.missing.length) return;
  var m = readMaster_();
  var n = sh.getMaxRows() - 1;
  listRule_(sh.getRange(2, c.device, n, 1), m.devices);
  listRule_(sh.getRange(2, c.supplier, n, 1), m.suppliers);
  listRule_(sh.getRange(2, c.cloud, n, 1), m.clouds);
  listRule_(sh.getRange(2, c.reason, n, 1), m.reasons);
}

/** 行が増えていたら、増えた分にも入力ルールを付け直す */
function extendLedgerRules_(sh) {
  var done = Number(PropertiesService.getDocumentProperties().getProperty('ledgerRows')) || 0;
  if (sh.getMaxRows() > done) applyLedgerRules_();
}

function listRule_(range, list) {
  if (!list.length) {
    range.clearDataValidations();
    return;
  }
  range.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(list.slice(0, 500), true).setAllowInvalid(true).build());
}

/** 患者一覧の色分け（上にあるものほど優先） */
function ledgerFormatRules_(sh, c) {
  var n = sh.getMaxRows() - 1;
  var L = function (k) { return '$' + a1col_(c[k]); };
  var col = function (k) { return sh.getRange(2, c[k], n, 1); };
  var named = L('name') + '2<>""';
  var rules = [];
  var add = function (formula, ranges, bg, font) {
    var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula)
      .setBackground(bg).setRanges(ranges);
    if (font) b.setFontColor(font);
    rules.push(b.build());
  };
  // 赤：直してほしいもの
  add('=AND(' + L('id') + '2<>"",COUNTIF(' + L('id') + ':' + L('id') + ',' + L('id') + '2)>1)',
    [col('id')], C_ALERT, C_ALERT_FONT);
  add('=AND(' + named + ',' + L('id') + '2="")', [col('id')], C_ALERT);
  ['device', 'supplier', 'intro'].forEach(function (k) {
    add('=AND(' + named + ',' + L(k) + '2="")', [col(k)], C_ALERT);
  });
  DATE_KEYS.forEach(function (k) {
    add('=AND(' + L(k) + '2<>"",NOT(ISNUMBER(' + L(k) + '2)))', [col(k)], C_ALERT, C_ALERT_FONT);
  });
  add('=AND(ISNUMBER(' + L('exit') + '2),ISNUMBER(' + L('intro') + '2),' + L('exit') + '2<' + L('intro') + '2)',
    [col('exit')], C_ALERT, C_ALERT_FONT);
  add('=AND(ISNUMBER(' + L('repStart') + '2),ISNUMBER(' + L('repEnd') + '2),' +
    L('repEnd') + '2<' + L('repStart') + '2)', [col('repStart'), col('repEnd')], C_ALERT, C_ALERT_FONT);
  // オレンジ：確認してほしいもの
  add('=AND(' + L('status') + '2="' + STATUS_EXIT + '",' + L('target') + '2<>"")', [col('target')], C_WARN, C_WARN_FONT);
  add('=AND(' + L('status') + '2="' + STATUS_EXIT + '",' + L('exit') + '2="")', [col('exit')], C_WARN, C_WARN_FONT);
  add('=AND(' + L('status') + '2="' + STATUS_EXIT + '",' + L('reason') + '2="")', [col('reason')], C_WARN, C_WARN_FONT);
  add('=AND(' + named + ',COUNTIF(' + L('name') + ':' + L('name') + ',' + L('name') + '2)>1)',
    [col('name')], C_WARN, C_WARN_FONT);
  // 水色：対象（○）なのにレポート期間が入っていない
  add('=AND(' + L('target') + '2<>"",OR(' + L('repStart') + '2="",' + L('repEnd') + '2=""))',
    [col('repStart'), col('repEnd')], C_TODO);
  // グレー：離脱した人（行全体）
  add('=' + L('status') + '2="' + STATUS_EXIT + '"', [sh.getRange(2, 1, n, c.lastCol)], C_EXIT_BG, C_EXIT_FONT);
  return rules;
}

function protectHeaderRow_(sh, row, desc) {
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === desc) p.remove();
  });
  sh.getRange(row, 1, 1, sh.getMaxColumns()).protect().setDescription(desc).setWarningOnly(true);
}

function arrangeTabs_() {
  var ss = ss_();
  var pos = 1;
  TAB_ORDER.forEach(function (key) {
    var sh = ss.getSheetByName(SH[key]);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
    sh.setTabColor(INPUT_TABS[key] ? '#34a853' : (key === 'guide' ? '#9e9e9e' : '#4a86e8'));
  });
}

/** 新しいファイルに最初からある、空の「シート1」を片付ける（何か入っていれば残す） */
function removeBlankDefaultSheet_() {
  ['シート1', 'Sheet1'].forEach(function (name) {
    var sh = ss_().getSheetByName(name);
    if (sh && !ownedKey_(sh) && sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss_().getSheets().length > 1) {
      ss_().deleteSheet(sh);
    }
  });
}

function countPatients_() {
  var sh = findSheet_('ledger');
  if (!sh) return 0;
  var c = ledgerCols_(sh);
  if (!c.name) return 0;
  return columnValues_(sh, c.name).filter(function (v) { return trim_(v) !== ''; }).length;
}


// ============================================================
// 患者一覧に入力したときの自動処理
// ============================================================
function onLedgerEdit_(e, sh) {
  var c = ledgerCols_(sh);
  if (c.missing.length) return;
  var top = Math.max(e.range.getRow(), 2);
  var bottom = e.range.getLastRow();
  if (bottom < top || bottom - top + 1 > 300) return;   // 大量の貼り付けは定期更新で整える
  var left = e.range.getColumn();
  var right = e.range.getLastColumn();
  var touched = function (k) { return c[k] >= left && c[k] <= right; };
  if (!LEDGER.some(function (col) { return touched(col.key); })) return;

  initTz_();
  var today = todayDn_();
  var rows = sh.getRange(top, 1, bottom - top + 1, c.lastCol).getValues();
  var master = (touched('device') || touched('supplier')) ? readMaster_() : null;
  var idInfo = null;
  var msgs = [];

  rows.forEach(function (r, i) {
    var row = top + i;
    var get = function (k) { return r[c[k] - 1]; };
    var put = function (k, v) {
      r[c[k] - 1] = v;
      sh.getRange(row, c[k]).setValue(v);
    };

    // 1) 日付：t／y／8桁／和暦などを本物の日付に直す
    DATE_KEYS.forEach(function (k) {
      if (!touched(k)) return;
      var v = get(k);
      if (v === '' || v === null || v instanceof Date) return;
      var dn = parseDateText_(v, today);
      if (dn !== null) put(k, dnToCellDate_(dn));
      else msgs.push(row + '行目の' + HEAD[k] + '「' + v + '」は日付として読めません。');
    });

    // 1b) 対象：何か入れたら「○」に（×・0 などは空欄に）
    if (touched('target')) {
      var mark = targetMark_(get('target'));
      if (get('target') !== mark) put('target', mark);
    }

    var name = trim_(get('name'));
    if (!name) return;

    // 2) 名前が入ったら ID を自動で（IDがすべて数字のときだけ）
    if (touched('name') && !trim_(get('id'))) {
      var lock = docLock_(5000);   // 同時に2人が入力しても同じ番号にならないように（取れなくても続ける）
      try {
        if (!idInfo) idInfo = nextIdInfo_(columnValues_(sh, c.id));
        if (idInfo.auto) put('id', idInfo.next++);
      } finally {
        if (lock) lock.releaseLock();
      }
    }

    // 3) 状態は離脱日に合わせる
    var status = trim_(get('status'));
    var exitDn = dnOf_(get('exit'), today);
    var want = null;
    if (exitDn !== null) {
      want = exitDn <= today ? STATUS_EXIT : STATUS_ACTIVE;
      if (touched('exit') && exitDn > today) {
        msgs.push(row + '行目：離脱日が未来の日付です。その日になると自動で「離脱」になります。');
      }
      if (touched('status') && status === STATUS_ACTIVE && want === STATUS_EXIT) {
        msgs.push(row + '行目：離脱日が入っているので「離脱」のままにしました。利用中に戻すときは離脱日を消してください。');
      }
    } else if (touched('exit') && !touched('status') && status === STATUS_EXIT) {
      want = STATUS_ACTIVE;   // 離脱日を消した → 利用中に戻す
    } else if (status !== STATUS_ACTIVE && status !== STATUS_EXIT) {
      want = expectedStatus_({ exit: null, status: status }, today);
    } else if (touched('status') && status === STATUS_EXIT) {
      msgs.push(row + '行目：離脱日も入れてください（月別・週別の離脱数に使います）。');
    }
    if (want && want !== status) put('status', want);
    if (touched('exit') && exitDn !== null && exitDn <= today) {
      if (get('target') !== '' && !touched('target')) {
        put('target', '');   // 旧バージョンと同じく、離脱したら対象から外す
        msgs.push(row + '行目：離脱したので対象（○）を外しました。');
      }
      if (!trim_(get('reason'))) msgs.push(row + '行目：離脱理由も選んでください。');
    }

    // 4) 機器 → クラウド区分（マスタにあれば）、業者（1社だけなら自動で入れる）
    if (master && touched('device')) {
      var cl = cloudOf_(master, trim_(get('device')));
      if (cl && get('cloud') !== cl) put('cloud', cl);
    }
    if (master && (touched('device') || touched('supplier'))) {
      var dev = trim_(get('device'));
      var sup = trim_(get('supplier'));
      var info = dev ? master.info[dev] : null;
      if (dev && !info) {
        if (touched('device')) msgs.push(row + '行目：機器「' + dev + '」は［マスタ］にありません。');
      } else if (info && !sup && touched('device')) {
        if (info.suppliers.length === 1) put('supplier', info.suppliers[0]);
        else if (info.suppliers.length > 1) {
          msgs.push(row + '行目：' + dev + ' の業者を「' + info.suppliers.join('／') + '」から選んでください。');
        }
      } else if (info && sup && info.suppliers.length && info.suppliers.indexOf(sup) < 0) {
        msgs.push(row + '行目：' + dev + ' と ' + sup + ' の組み合わせは［マスタ］にありません。');
      }
    }

    // 5) レポート期間の前後
    if (touched('repStart') || touched('repEnd')) {
      var s = dnOf_(get('repStart'), today);
      var en = dnOf_(get('repEnd'), today);
      if (s !== null && en !== null && en < s) msgs.push(row + '行目：レポート終了日が開始日より前になっています。');
    }
  });

  if (msgs.length) {
    ss_().toast(msgs.slice(0, 3).join('\n') + (msgs.length > 3 ? '\nほか' + (msgs.length - 3) + '件' : ''),
      'CPAP管理', 8);
  }
}

/** 機器別一覧の黄色いセル（クラウド・機器・業者・状態・対象）を変えたら、その場で表示を切り替える */
function onDeviceSelectorEdit_(e) {
  var r = e.range;
  if (r.getRow() > 3 || r.getLastRow() < 3 || r.getLastColumn() < 3 || r.getColumn() > 7) return;
  var ctx = loadContext_();
  writeDeviceList_(ctx, categoryLists_(ctx));
}

/** 離脱日から決まる状態。変えなくてよいときは null */
function expectedStatus_(p, today) {
  if (p.exit !== null) return p.exit <= today ? STATUS_EXIT : STATUS_ACTIVE;
  if (p.status === STATUS_ACTIVE || p.status === STATUS_EXIT) return null;   // 離脱日なしの「離脱」はそのまま（要確認に出す）
  if (/離脱|移管|中止|終了/.test(p.status)) return STATUS_EXIT;
  return STATUS_ACTIVE;                                                     // 空欄・「予定」など
}

/** 次のID。数字以外のIDが1つでもあれば自動採番しない */
function nextIdInfo_(values) {
  var max = 0;
  for (var i = 0; i < values.length; i++) {
    var s = trim_(values[i]);
    if (!s) continue;
    if (!/^\d+$/.test(s)) return { auto: false, next: '' };
    max = Math.max(max, Number(s));
  }
  return { auto: true, next: max + 1 };
}


// ============================================================
// サイドバー（新規登録・レポート期間）から呼ばれる処理
// ============================================================
function getFormData() {
  initTz_();
  var m = readMaster_();
  var sh = findSheet_('ledger');
  if (!sh) throw configError_('「' + SH.ledger + '」タブがありません。先に初期セットアップを実行してください。');
  var c = ledgerCols_(sh);
  requireCols_(c);
  var idInfo = nextIdInfo_(columnValues_(sh, c.id));
  var today = todayDn_();
  var t = ymd_(today);
  var monthStart = dn_(t.y, t.m, 1);
  var lastMonthStart = addMonthsDn_(monthStart, -1);
  var deviceSuppliers = {};
  m.devices.forEach(function (d) { deviceSuppliers[d] = m.info[d].suppliers; });
  return {
    devices: m.devices,
    suppliers: m.suppliers,
    deviceSuppliers: deviceSuppliers,
    nextId: idInfo.auto ? idInfo.next : '',
    today: isoDn_(today),
    yesterday: isoDn_(today - 1),
    lastMonth: { start: isoDn_(lastMonthStart), end: isoDn_(monthStart - 1) },
    thisMonth: { start: isoDn_(monthStart), end: today - 1 >= monthStart ? isoDn_(today - 1) : '' }
  };
}

function registerPatient(form) {
  initTz_();
  form = form || {};
  var name = trim_(form.name);
  var device = trim_(form.device);
  var supplier = trim_(form.supplier);
  var intro = isoToDn_(form.intro);
  var repStart = isoToDn_(form.repStart);
  var repEnd = isoToDn_(form.repEnd);
  if (!name) throw new Error('名前を入れてください。');
  if (!device) throw new Error('機器を選んでください。');
  if (!supplier) throw new Error('業者を選んでください。');
  if (intro === null) throw new Error('導入日を入れてください。');
  if ((repStart === null) !== (repEnd === null)) throw new Error('レポート期間は開始日と終了日の両方を入れてください。');
  if (repStart !== null && repEnd < repStart) throw new Error('レポート終了日が開始日より前になっています。');
  var master = readMaster_();
  var info = master.info[device];
  if (info && info.suppliers.length && info.suppliers.indexOf(supplier) < 0) {
    throw new Error(device + ' の業者は「' + info.suppliers.join('／') + '」から選んでください。');
  }

  var lock = docLock_(20000);
  if (!lock) throw new Error('ほかの人が登録・更新しているところです。少し待ってからもう一度お試しください。');
  try {
    var sh = findSheet_('ledger');
    var c = ledgerCols_(sh);
    requireCols_(c);
    var last = sh.getLastRow();
    var data = last >= 2 ? sh.getRange(2, 1, last - 1, c.lastCol).getValues() : [];
    var ids = data.map(function (r) { return trim_(r[c.id - 1]); });
    var id = trim_(form.id);
    if (id && ids.indexOf(id) >= 0) throw new Error('ID「' + id + '」はすでに使われています。');
    if (!id) {
      var idInfo = nextIdInfo_(ids);
      if (idInfo.auto) id = String(idInfo.next);
    }
    if (!form.force) {
      var same = [];
      data.forEach(function (r, i) { if (nameKey_(r[c.name - 1]) === nameKey_(name)) same.push(i + 2); });
      if (same.length) {
        return { status: 'dup', message: '「' + name + '」さんはすでに登録があります（' + same.join('・') +
          '行目）。同姓同名の別の方として登録しますか？' };
      }
    }
    var row = Math.max(last + 1, 2);
    ensureSize_(sh, row, c.lastCol);
    var rec = {
      id: /^\d+$/.test(id) ? Number(id) : id,
      name: name, device: device, supplier: supplier, cloud: cloudOf_(master, device),
      repStart: repStart === null ? '' : dnToCellDate_(repStart),
      repEnd: repEnd === null ? '' : dnToCellDate_(repEnd),
      target: form.target === false ? '' : TARGET_MARK,
      intro: dnToCellDate_(intro), exit: '', note: trim_(form.note),
      status: STATUS_ACTIVE, reason: ''
    };
    LEDGER.forEach(function (col) {
      if (rec[col.key] !== '') sh.getRange(row, c[col.key]).setValue(rec[col.key]);
    });
    SpreadsheetApp.flush();
    var next = nextIdInfo_(ids.concat([id]));
    return {
      status: 'ok',
      message: row + '行目に登録しました：' + name + '（ID ' + (id || 'なし') + '）',
      nextId: next.auto ? next.next : ''
    };
  } finally {
    lock.releaseLock();
  }
}

function getSelectionInfo() {
  initTz_();
  var sel = selectedLedgerRows_();
  var marked = sel.targets.filter(function (t) { return targetMark_(t.values[sel.cols.target - 1]) === TARGET_MARK; });
  return { count: sel.targets.length, message: selectionText_(sel) + '\nうち対象（○）が付いている人：' + marked.length + '人' };
}

/**
 * 選んだ行のレポート期間を入れる／消す。
 *   mode: 'fixed'（開始日〜終了日を指定）／'continue'（前回の終了日の翌日〜終了日）／'clear'
 *   mark: true なら、期間を入れた人の「対象」に○も付ける
 * 離脱した人と、フィルタで隠れている行には入れません。
 */
function applyReportPeriod(req) {
  initTz_();
  req = req || {};
  var sel = selectedLedgerRows_();
  var sh = sel.sheet;
  var c = sel.cols;
  var today = todayDn_();
  var start = isoToDn_(req.start);
  var end = isoToDn_(req.end);
  if (req.mode === 'fixed') {
    if (start === null || end === null) throw new Error('開始日と終了日を入れてください。');
    if (end < start) throw new Error('終了日が開始日より前になっています。');
  } else if (req.mode === 'continue') {
    if (end === null) throw new Error('終了日を入れてください。');
  } else if (req.mode !== 'clear') {
    throw new Error('期間の決め方を選んでください。');
  }
  if (!sel.targets.length) throw new Error('対象の行がありません。' + selectionText_(sel));

  var done = 0;
  var skipped = [];
  sel.targets.forEach(function (t) {
    if (req.mode === 'clear') {
      sh.getRange(t.row, c.repStart).clearContent();
      sh.getRange(t.row, c.repEnd).clearContent();
      done++;
      return;
    }
    var s = start;
    if (req.mode === 'continue') {
      var prev = dnOf_(t.values[c.repEnd - 1], today);
      s = prev !== null ? prev + 1 : dnOf_(t.values[c.intro - 1], today);
      if (s === null) { skipped.push(t.row + '行目（前回の終了日も導入日もありません）'); return; }
      if (s > end) { skipped.push(t.row + '行目（前回の終了日が ' + fmtDn_(end) + ' 以降です）'); return; }
    }
    sh.getRange(t.row, c.repStart).setValue(dnToCellDate_(s));
    sh.getRange(t.row, c.repEnd).setValue(dnToCellDate_(end));
    if (req.mark) sh.getRange(t.row, c.target).setValue(TARGET_MARK);
    done++;
  });
  SpreadsheetApp.flush();
  var msg = (req.mode === 'clear' ? 'レポート期間を消しました：' : 'レポート期間を入れました：') + done + '人' +
    (req.mark && req.mode !== 'clear' && done ? '（対象に○も付けました）' : '');
  if (skipped.length) {
    msg += '\n入れなかった行：' + skipped.slice(0, 10).join('、') + (skipped.length > 10 ? ' ほか' : '');
  }
  return { message: msg };
}

/** 選んだ行の「対象」に○を付ける（mode 'on'）／外す（mode 'off'）。外すときは離脱した人も含める */
function setTargetMarks(req) {
  initTz_();
  var on = req && req.mode === 'on';
  var sel = selectedLedgerRows_(!on);
  if (!sel.targets.length) throw new Error('対象の行がありません。' + selectionText_(sel));
  sel.targets.forEach(function (t) {
    sel.sheet.getRange(t.row, sel.cols.target).setValue(on ? TARGET_MARK : '');
  });
  SpreadsheetApp.flush();
  return { message: (on ? '対象に○を付けました：' : '対象の○を外しました：') + sel.targets.length + '人' };
}

/** 対象（○）をすべて消す。confirmed でないときは、いくつ付いているかだけ返す */
function clearAllTargets(req) {
  var sh = findSheet_('ledger');
  if (!sh) throw configError_('「' + SH.ledger + '」タブがありません。先に初期セットアップを実行してください。');
  var c = ledgerCols_(sh);
  requireCols_(c);
  var vals = columnValues_(sh, c.target);
  var count = vals.filter(function (v) { return targetMark_(v) === TARGET_MARK; }).length;
  if (!req || !req.confirmed) return { count: count, done: false };
  if (vals.length) sh.getRange(2, c.target, vals.length, 1).clearContent();
  SpreadsheetApp.flush();
  return { count: count, done: true, message: '対象（○）をすべて消しました：' + count + '人' };
}

/** メニュー：対象（○）をすべて消す（レポートを出し終わったあとに使う） */
function clearTargetMarks() {
  withUi_(function () {
    var ui = SpreadsheetApp.getUi();
    var n = clearAllTargets({}).count;
    if (!n) {
      ui.alert('対象（○）が付いている人はいません。');
      return;
    }
    if (ui.alert('対象（○）をすべて消す', 'いま ' + n + '人に「○」が付いています。すべて空欄に戻しますか？\n' +
        '（レポート期間はそのまま残ります）', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
    ss_().toast(clearAllTargets({ confirmed: true }).message, 'CPAP管理', 5);
  });
}

function refreshFromSidebar() {
  var r = refreshAll_({ wait: 30000 });
  return r.skipped ? 'ほかの更新が実行中です。少し待ってからもう一度お試しください。'
                   : '集計を更新しました（' + r.patients + '人）。';
}

/** 患者一覧で選ばれている行（空行・フィルタで隠れた行と、includeExited でなければ離脱した人も除く） */
function selectedLedgerRows_(includeExited) {
  var ss = ss_();
  var sh = ss.getActiveSheet();
  if (sh.getName() !== SH.ledger) {
    throw new Error('「' + SH.ledger + '」タブで、期間を入れたい人の行を選んでから押してください。');
  }
  var c = ledgerCols_(sh);
  requireCols_(c);
  var list = ss.getActiveRangeList();
  var ranges = list ? list.getRanges() : [ss.getActiveRange()];
  var last = sh.getLastRow();
  var rowSet = {};
  ranges.forEach(function (r) {
    if (!r) return;
    for (var i = Math.max(r.getRow(), 2); i <= Math.min(r.getLastRow(), last); i++) rowSet[i] = true;
  });
  var rows = Object.keys(rowSet).map(Number).sort(function (a, b) { return a - b; });
  var sel = { sheet: sh, cols: c, targets: [], hidden: 0, blank: 0, exited: 0 };
  if (!rows.length) return sel;
  var first = rows[0];
  var block = sh.getRange(first, 1, rows[rows.length - 1] - first + 1, c.lastCol).getValues();
  var filtered = !!sh.getFilter();
  rows.forEach(function (row) {
    var v = block[row - first];
    if (!trim_(v[c.name - 1])) { sel.blank++; return; }
    if (filtered && sh.isRowHiddenByFilter(row)) { sel.hidden++; return; }
    if (!includeExited && trim_(v[c.status - 1]) === STATUS_EXIT) { sel.exited++; return; }
    sel.targets.push({ row: row, values: v });
  });
  return sel;
}

function selectionText_(sel) {
  var out = [];
  if (sel.exited) out.push('離脱 ' + sel.exited + '人');
  if (sel.hidden) out.push('絞り込みで非表示 ' + sel.hidden + '行');
  if (sel.blank) out.push('空の行 ' + sel.blank + '行');
  return '選択中：' + sel.targets.length + '人' + (out.length ? '（対象外：' + out.join('・') + '）' : '');
}


// ============================================================
// 集計（読み込み → 計算 → 各タブに書き出し）
// ============================================================
function refreshAll_(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(opts.wait || 1000)) return { skipped: true, patients: 0 };
  try {
    var ctx = opts.ctx || loadContext_();
    var synced = false;
    var docLock = docLock_(10000);
    if (docLock) {
      try {
        syncLedger_(ctx);
        synced = true;
      } finally {
        docLock.releaseLock();
      }
    }
    extendLedgerRules_(ctx.sheet);
    var lists = categoryLists_(ctx);
    var periods = {
      month: periodTable_(ctx.patients, 'month', ctx.today, lists),
      week: periodTable_(ctx.patients, 'week', ctx.today, lists),
      year: periodTable_(ctx.patients, 'year', ctx.today, lists)
    };
    writeDashboard_(ctx, lists, periods, dataChecks_(ctx));
    writePeriodSheet_('month', ctx, lists, periods.month);
    writePeriodSheet_('week', ctx, lists, periods.week);
    writePeriodSheet_('year', ctx, lists, periods.year);
    writeDeviceList_(ctx, lists);
    writeExitSheet_(ctx, lists);
    writeCostSheet_(ctx);
    if (ss_().getSheetByName(SH.anon)) writeAnonSheet_(ctx);
    var props = PropertiesService.getDocumentProperties();
    props.setProperty('lastRefresh', ctx.stamp);
    if (synced) props.setProperty('lastSig', signature_(ctx));
    return { skipped: false, patients: ctx.patients.length };
  } finally {
    lock.releaseLock();
  }
}

/** 患者一覧とマスタを読み込む */
function loadContext_() {
  initTz_();
  var sh = findSheet_('ledger');
  if (!sh) {
    throw configError_('「' + SH.ledger + '」タブがありません。' +
      'メニュー［CPAP管理］→［管理・設定］→［初期セットアップ／修復］を実行してください。');
  }
  var c = ledgerCols_(sh);
  requireCols_(c);
  var last = sh.getLastRow();
  var values = last >= 2 ? sh.getRange(2, 1, last - 1, c.lastCol).getValues() : [];
  var today = todayDn_();
  var ctx = {
    sheet: sh, cols: c, values: values, master: readMaster_(), today: today,
    stamp: Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'),
    patients: [], orphans: []
  };
  for (var i = 0; i < values.length; i++) {
    var p = parsePatient_(values[i], c, i + 2, today);
    if (p.name) ctx.patients.push(p);
    else if (p.hasData) ctx.orphans.push(p);
  }
  return ctx;
}

function parsePatient_(r, c, row, today) {
  var g = function (k) { return r[c[k] - 1]; };
  var p = {
    row: row, id: g('id'), idText: trim_(g('id')), name: trim_(g('name')),
    device: trim_(g('device')), supplier: trim_(g('supplier')), cloud: trim_(g('cloud')), note: trim_(g('note')),
    status: trim_(g('status')), reason: trim_(g('reason')), raw: {}, bad: {}, fix: {}
  };
  var mark = targetMark_(g('target'));
  p.target = mark === TARGET_MARK;
  p.targetFix = g('target') !== mark ? mark : null;   // ○ 以外の書き方（TRUE・x など）は同期のときに直す
  p.hasData = !!(p.idText || p.device || p.supplier || p.note || p.reason || p.target);
  DATE_KEYS.forEach(function (k) {
    var v = g(k);
    p.raw[k] = v;
    p[k] = null;
    if (v === '' || v === null || v === undefined) return;
    p.hasData = true;
    if (v instanceof Date) {
      p[k] = cellDn_(v);
      if (p[k] === null) p.bad[k] = true;
      return;
    }
    var dn = parseDateText_(v, today);
    if (dn === null) p.bad[k] = true;
    else { p[k] = dn; p.fix[k] = dn; }   // 文字で入った日付 → 本物の日付に直す
  });
  return p;
}

/** 状態を離脱日に合わせ、文字の日付を日付に直し、空のIDを採番する（変わるセルだけ書く） */
function syncLedger_(ctx) {
  var sh = ctx.sheet;
  var c = ctx.cols;
  var writes = [];
  var put = function (p, key, value) {
    writes.push([p.row, c[key], value]);
    ctx.values[p.row - 2][c[key] - 1] = value;
  };
  var idInfo = nextIdInfo_(ctx.values.map(function (r) { return r[c.id - 1]; }));
  ctx.patients.forEach(function (p) {
    for (var k in p.fix) {
      var d = dnToCellDate_(p.fix[k]);
      put(p, k, d);
      p.raw[k] = d;
    }
    p.fix = {};
    if (p.targetFix !== null) {
      put(p, 'target', p.targetFix);
      p.targetFix = null;
    }
    if (!p.idText && idInfo.auto) {
      put(p, 'id', idInfo.next);
      p.id = idInfo.next;
      p.idText = String(idInfo.next);
      idInfo.next++;
    }
    var cloud = cloudOf_(ctx.master, p.device);
    if (cloud && cloud !== p.cloud) {
      put(p, 'cloud', cloud);
      p.cloud = cloud;
    }
    var want = expectedStatus_(p, ctx.today);
    if (want && want !== p.status) {
      put(p, 'status', want);
      p.status = want;
    }
  });
  writes.forEach(function (w) { sh.getRange(w[0], w[1]).setValue(w[2]); });
  return writes.length;
}

/** マスタの読み込み（見出しの名前で列を探す） */
function readMaster_() {
  var m = { combos: [], devices: [], suppliers: [], clouds: [], reasons: [], info: {}, combo: {}, raw: [], broken: false };
  var sh = findSheet_('master');
  if (!sh || sh.getLastRow() < 5) return m;
  var lastCol = Math.max(sh.getLastColumn(), REASON_COL);
  var head = rowText_(sh, 4);
  var at = function (name) { return head.indexOf(name); };
  var idx = MASTER_HEAD.map(at);
  var iReason = at(REASON_HEAD);
  m.broken = idx[0] < 0 || idx[1] < 0;
  var vals = sh.getRange(5, 1, sh.getLastRow() - 4, lastCol).getValues();
  m.raw = vals;
  vals.forEach(function (r) {
    var f = function (i) { return idx[i] >= 0 ? r[idx[i]] : ''; };
    var dev = trim_(f(0));
    var sup = trim_(f(1));
    if (dev || sup) {
      var cb = {
        device: dev, supplier: sup, maker: trim_(f(2)), cloud: trim_(f(3)),
        price: num_(f(4)), freeFirst: trim_(f(5)) === 'あり', note: trim_(f(6))
      };
      var key = comboKey_(dev, sup);
      if (!(dev && sup && m.combo[key])) {
        m.combos.push(cb);
        if (dev && sup) m.combo[key] = cb;
      }
      if (dev) {
        if (!m.info[dev]) {
          m.info[dev] = { cloud: cb.cloud, maker: cb.maker, suppliers: [] };
          m.devices.push(dev);
        }
        if (!m.info[dev].cloud && cb.cloud) m.info[dev].cloud = cb.cloud;
        if (sup && m.info[dev].suppliers.indexOf(sup) < 0) m.info[dev].suppliers.push(sup);
      }
      if (sup && m.suppliers.indexOf(sup) < 0) m.suppliers.push(sup);
      if (cb.cloud && m.clouds.indexOf(cb.cloud) < 0) m.clouds.push(cb.cloud);
    }
    var rs = iReason >= 0 ? trim_(r[iReason]) : '';
    if (rs && m.reasons.indexOf(rs) < 0) m.reasons.push(rs);
  });
  return m;
}

/** 集計に出す機器・業者の並び（マスタの順 → マスタにないもの → 未入力）。患者がいるものだけ。 */
function categoryLists_(ctx) {
  var pick = function (masterList, valueOf) {
    var seen = {};
    var extra = [];
    var none = false;
    ctx.patients.forEach(function (p) {
      var v = valueOf(p);
      if (!v) { none = true; return; }
      if (!seen[v]) {
        seen[v] = true;
        if (masterList.indexOf(v) < 0) extra.push(v);
      }
    });
    var out = masterList.filter(function (v) { return seen[v]; }).concat(extra);
    if (none) out.push(NONE);
    return out;
  };
  return {
    devices: pick(ctx.master.devices, function (p) { return p.device; }),
    clouds: pick(ctx.master.clouds, function (p) { return p.cloud; }),
    suppliers: pick(ctx.master.suppliers, function (p) { return p.supplier; })
  };
}

function devOf_(p) { return p.device || NONE; }
function cloudOf_(master, device) { return device && master.info[device] ? master.info[device].cloud : ''; }
function clOf_(p) { return p.cloud || NONE; }
function supOf_(p) { return p.supplier || NONE; }

/** 導入日があり、離脱日が導入日より前でない（期間の集計に使える） */
function isValidSpan_(p) {
  return p.intro !== null && (p.exit === null || p.exit >= p.intro);
}

/** その日に利用中だったか（離脱日の当日は利用していない扱い） */
function activeAt_(p, day) {
  return isValidSpan_(p) && p.intro <= day && (p.exit === null || p.exit > day);
}

/** 導入から months ヶ月たった人のうち、その時点で続けていた人の割合 */
function retention_(patients, today, months) {
  var num = 0;
  var den = 0;
  patients.forEach(function (p) {
    if (!isValidSpan_(p)) return;
    var mark = addMonthsDn_(p.intro, months);
    if (mark > today) return;
    den++;
    if (p.exit === null || p.exit >= mark) num++;
  });
  return { num: num, den: den, rate: den ? num / den : null };
}

function rateText_(r) {
  return r.den ? Math.round(r.rate * 100) + '%（' + r.num + '/' + r.den + '）' : '—';
}

/** ダッシュボードの数字 */
function dashboardStats_(patients, today, lists) {
  var t = ymd_(today);
  var mStart = dn_(t.y, t.m, 1);
  var lmStart = addMonthsDn_(mStart, -1);
  var lmEnd = mStart - 1;
  var wStart = weekStartDn_(today);
  var lwStart = wStart - 7;
  var within = function (dn, a, b) { return dn !== null && dn >= a && dn <= b; };
  var k = {
    active: 0, activeLastMonthEnd: 0, introThisMonth: 0, introLastMonth: 0, exitThisMonth: 0,
    exitLastMonth: 0, introThisWeek: 0, introLastWeek: 0, total: patients.length, totalExit: 0,
    marked: 0, markedNoPeriod: 0
  };
  var table = function (names) {
    var map = {};
    names.forEach(function (n) { map[n] = [n, 0, 0, 0, 0]; });
    return map;
  };
  var dev = table(lists.devices);
  var sup = table(lists.suppliers);
  patients.forEach(function (p) {
    var active = p.status === STATUS_ACTIVE;
    var exited = p.status === STATUS_EXIT;
    var newThisMonth = within(p.intro, mStart, today);
    if (active) k.active++;
    if (exited) k.totalExit++;
    if (p.target) {
      k.marked++;
      if (p.repStart === null || p.repEnd === null) k.markedNoPeriod++;
    }
    if (activeAt_(p, lmEnd)) k.activeLastMonthEnd++;
    if (newThisMonth) k.introThisMonth++;
    if (within(p.intro, lmStart, lmEnd)) k.introLastMonth++;
    if (within(p.exit, mStart, today)) k.exitThisMonth++;
    if (within(p.exit, lmStart, lmEnd)) k.exitLastMonth++;
    if (within(p.intro, wStart, today)) k.introThisWeek++;
    if (within(p.intro, lwStart, wStart - 1)) k.introLastWeek++;
    [dev[devOf_(p)], sup[supOf_(p)]].forEach(function (row) {
      if (!row) return;
      if (active) row[1]++;
      if (newThisMonth) row[2]++;
      if (exited) row[3]++;
      row[4]++;
    });
  });
  k.ret1y = retention_(patients, today, 12);
  var withTotal = function (map, names) {
    var rows = names.map(function (n) { return map[n]; });
    var total = ['合計', 0, 0, 0, 0];
    rows.forEach(function (r) { for (var i = 1; i < 5; i++) total[i] += r[i]; });
    return rows.length ? rows.concat([total]) : [];
  };
  var byDate = function (key) {
    return function (a, b) { return (b[key] - a[key]) || (b.row - a.row); };
  };
  return {
    kpi: k,
    byDevice: withTotal(dev, lists.devices),
    bySupplier: withTotal(sup, lists.suppliers),
    recentIntro: patients.filter(function (p) { return p.intro !== null && p.intro <= today; })
      .sort(byDate('intro')).slice(0, 10)
      .map(function (p) { return [p.raw.intro, p.id, p.device, p.supplier, p.status]; }),
    recentExit: patients.filter(function (p) { return p.exit !== null && p.exit <= today; })
      .sort(byDate('exit')).slice(0, 10)
      .map(function (p) {
        return [p.raw.exit, p.id, p.device, p.reason, durationText_(monthsBetween_(p.intro, p.exit))];
      })
  };
}

/**
 * 期間ごとの表（kind：'month'／'week'／'year'）。新しい順。
 * 導入数・離脱数は今日までのものだけ数え、期末の利用者数は「導入数の累計 − 離脱数の累計」。
 */
function periodTable_(patients, kind, today, lists) {
  var valid = patients.filter(function (p) {
    return isValidSpan_(p) && p.intro <= today && ymd_(p.intro).y >= 2000;
  });
  if (!valid.length) return { rows: [] };
  var first = valid.reduce(function (m, p) { return Math.min(m, p.intro); }, valid[0].intro);
  var periods = makePeriods_(kind, first, today);
  var index = periodIndexer_(kind, periods[0].start);
  periods.forEach(function (x) {
    x.intro = 0;
    x.exit = 0;
    x.byDevice = zeros_(lists.devices.length);
    x.bySupplier = zeros_(lists.suppliers.length);
  });
  valid.forEach(function (p) {
    var a = periods[index(p.intro)];
    a.intro++;
    var di = lists.devices.indexOf(devOf_(p));
    if (di >= 0) a.byDevice[di]++;
    var si = lists.suppliers.indexOf(supOf_(p));
    if (si >= 0) a.bySupplier[si]++;
    if (p.exit !== null && p.exit <= today) periods[index(p.exit)].exit++;
  });
  var run = 0;
  periods.forEach(function (x) {
    x.net = x.intro - x.exit;
    run += x.net;
    x.active = run;
  });
  periods[periods.length - 1].isCurrent = true;
  return { rows: periods.reverse() };
}

/** 古い順の期間リスト */
function makePeriods_(kind, first, today) {
  var out = [];
  var s;
  if (kind === 'week') {
    for (s = weekStartDn_(first); s <= today; s += 7) {
      var e = s + 6;
      out.push({
        start: s, end: e,
        label: fmtDn_(s) + '〜' + (ymd_(e).y === ymd_(s).y ? fmtMd_(e) : fmtDn_(e)),
        short: ymd_(s).m + '/' + ymd_(s).d
      });
    }
  } else if (kind === 'month') {
    var f = ymd_(first);
    for (s = dn_(f.y, f.m, 1); s <= today; s = addMonthsDn_(s, 1)) {
      var t = ymd_(s);
      out.push({ start: s, end: addMonthsDn_(s, 1) - 1, label: t.y + '/' + pad2_(t.m), short: t.y + '/' + pad2_(t.m) });
    }
  } else {
    for (var y = ymd_(first).y; dn_(y, 1, 1) <= today; y++) {
      out.push({ start: dn_(y, 1, 1), end: dn_(y, 12, 31), label: y + '年', short: String(y) });
    }
  }
  return out;
}

function periodIndexer_(kind, start0) {
  var t0 = ymd_(start0);
  if (kind === 'week') return function (dn) { return Math.floor((weekStartDn_(dn) - start0) / 7); };
  if (kind === 'month') return function (dn) { var t = ymd_(dn); return (t.y - t0.y) * 12 + (t.m - t0.m); };
  return function (dn) { return ymd_(dn).y - t0.y; };
}

/** 入力もれ・矛盾のチェック。level：error（赤）／warn（オレンジ）／info（灰色） */
function dataChecks_(ctx) {
  var P = ctx.patients;
  var m = ctx.master;
  var nextYear = ymd_(ctx.today).y + 1;
  var checks = [];
  var add = function (label, level, list) {
    checks.push({ label: label, level: level, items: list.map(function (p) { return { row: p.row, id: p.idText }; }) });
  };
  var count = function (keyOf) {
    var n = {};
    P.forEach(function (p) { var k = keyOf(p); if (k) n[k] = (n[k] || 0) + 1; });
    return n;
  };
  var ids = count(function (p) { return p.idText; });
  var names = count(function (p) { return nameKey_(p.name); });
  var auto = nextIdInfo_(P.map(function (p) { return p.idText; })).auto;

  add('IDが空欄' + (auto ? '' : '（数字以外のIDがあるため、自動の番号付けはしていません）'), 'error',
    P.filter(function (p) { return !p.idText; }));
  add('IDが重複している', 'error', P.filter(function (p) { return p.idText && ids[p.idText] > 1; }));
  add('機器が空欄', 'error', P.filter(function (p) { return !p.device; }));
  add('業者が空欄', 'error', P.filter(function (p) { return !p.supplier; }));
  add('導入日が空欄', 'error', P.filter(function (p) { return p.intro === null && !p.bad.intro; }));
  add('日付として読めない値がある', 'error', P.filter(function (p) { return Object.keys(p.bad).length > 0; }));
  add('離脱日が導入日より前', 'error', P.filter(function (p) {
    return p.intro !== null && p.exit !== null && p.exit < p.intro;
  }));
  add('レポート終了日が開始日より前', 'error', P.filter(function (p) {
    return p.repStart !== null && p.repEnd !== null && p.repEnd < p.repStart;
  }));
  add('名前が空欄の行（ほかの欄には入力あり）', 'error', ctx.orphans);
  add('対象（○）なのにレポート期間が空欄', 'warn', P.filter(function (p) {
    return p.target && (p.repStart === null || p.repEnd === null);
  }));
  add('離脱しているのに対象（○）が付いている', 'warn', P.filter(function (p) {
    return p.target && p.status === STATUS_EXIT;
  }));
  add('「離脱」なのに離脱日が空欄（月別・週別の離脱数に入りません）', 'warn', P.filter(function (p) {
    return p.status === STATUS_EXIT && p.exit === null && !p.bad.exit;
  }));
  add('離脱理由が空欄', 'warn', P.filter(function (p) { return p.status === STATUS_EXIT && !p.reason; }));
  add('クラウド区分が空欄', 'warn', P.filter(function (p) { return !p.cloud; }));
  add('［マスタ］にない機器', 'warn', P.filter(function (p) { return p.device && !m.info[p.device]; }));
  add('［マスタ］にない業者', 'warn', P.filter(function (p) {
    return p.supplier && m.suppliers.indexOf(p.supplier) < 0;
  }));
  add('［マスタ］にない機器と業者の組み合わせ', 'warn', P.filter(function (p) {
    return m.info[p.device] && m.suppliers.indexOf(p.supplier) >= 0 && !m.combo[comboKey_(p.device, p.supplier)];
  }));
  add('日付が入力ミスかも（2000年より前／' + nextYear + '年より後）', 'warn', P.filter(function (p) {
    return DATE_KEYS.some(function (k) {
      return p[k] !== null && (ymd_(p[k]).y < 2000 || ymd_(p[k]).y > nextYear);
    });
  }));
  add('同じ名前が複数（同姓同名なら問題ありません）', 'info', P.filter(function (p) {
    return names[nameKey_(p.name)] > 1;
  }));
  if (m.broken) {
    checks.unshift({ label: '［マスタ］の見出し（機器・業者）が見つかりません。初期セットアップ／修復を実行してください',
                     level: 'error', items: [{ row: 0, id: '' }] });
  }
  return checks;
}

/** 離脱分析の数字 */
function exitStats_(patients, today, lists, reasonOrder) {
  var ty = ymd_(today).y;
  var exited = patients.filter(function (p) { return p.status === STATUS_EXIT; });
  var dated = exited.filter(function (p) { return isValidSpan_(p) && p.exit !== null; });
  var months = function (p) { return monthsBetween_(p.intro, p.exit); };
  var isEarly = function (p) { return p.exit < addMonthsDn_(p.intro, 3); };
  var thisYear = function (p) { return p.exit !== null && p.exit <= today && ymd_(p.exit).y === ty; };
  var avgOf = function (list) {
    if (!list.length) return null;
    return list.reduce(function (s, p) { return s + months(p); }, 0) / list.length;
  };

  var kpi = {
    total: exited.length,
    rate: patients.length ? exited.length / patients.length : null,
    thisYear: exited.filter(thisYear).length,
    early: dated.filter(isEarly).length,
    dated: dated.length,
    avgMonths: avgOf(dated)
  };

  var order = reasonOrder.slice();
  var cnt = {};
  var cntYear = {};
  exited.forEach(function (p) {
    var r = p.reason || NONE;
    if (order.indexOf(r) < 0) order.push(r);
    cnt[r] = (cnt[r] || 0) + 1;
    if (thisYear(p)) cntYear[r] = (cntYear[r] || 0) + 1;
  });
  var reasons = order.filter(function (r) { return cnt[r]; })
    .map(function (r) { return [r, cnt[r], cnt[r] / exited.length, cntYear[r] || 0]; });
  reasons.sort(function (a, b) { return b[1] - a[1]; });

  var buckets = [['3ヶ月未満', 0, 3], ['3〜6ヶ月', 3, 6], ['6ヶ月〜1年', 6, 12], ['1〜2年', 12, 24],
                 ['2〜3年', 24, 36], ['3年以上', 36, Infinity]];
  var durations = buckets.map(function (b) {
    var n = dated.filter(function (p) { var mm = months(p); return mm >= b[1] && mm < b[2]; }).length;
    return [b[0], n, dated.length ? n / dated.length : 0];
  });

  var byYear = {};
  patients.forEach(function (p) {
    if (!isValidSpan_(p) || p.intro > today) return;
    var y = ymd_(p.intro).y;
    (byYear[y] = byYear[y] || []).push(p);
  });
  var cohorts = Object.keys(byYear).map(Number).sort(function (a, b) { return b - a; }).map(function (y) {
    var g = byYear[y];
    return [y + '年', g.length, rateText_(retention_(g, today, 3)), rateText_(retention_(g, today, 12)),
            rateText_(retention_(g, today, 24)),
            g.filter(function (p) { return p.status === STATUS_ACTIVE; }).length];
  });

  var byDevice = lists.devices.map(function (d) {
    var all = patients.filter(function (p) { return devOf_(p) === d; });
    var ex = all.filter(function (p) { return p.status === STATUS_EXIT; });
    var dt = ex.filter(function (p) { return isValidSpan_(p) && p.exit !== null; });
    var avg = avgOf(dt);
    return [d, all.length, ex.length, all.length ? ex.length / all.length : 0,
            dt.filter(isEarly).length, avg === null ? '' : durationText_(Math.round(avg))];
  });

  var list = exited.slice().sort(function (a, b) {
    if (a.exit === null || b.exit === null) return (a.exit === null) - (b.exit === null);
    return (b.exit - a.exit) || (b.row - a.row);
  }).map(function (p) {
    return [p.device, p.raw.exit, p.id, p.raw.intro,
            durationText_(isValidSpan_(p) && p.exit !== null ? months(p) : null), p.supplier, p.reason];
  });

  return { kpi: kpi, reasons: reasons, durations: durations, cohorts: cohorts, byDevice: byDevice, list: list };
}

/**
 * 台数・費用：その月に1日でも利用があった台数（初月無料の組み合わせは導入月を数えない）× 月額。
 */
function costStats_(patients, master, today) {
  var t = ymd_(today);
  var cur = dn_(t.y, t.m, 1);
  var months = [];
  for (var i = 23; i >= 0; i--) {
    var s = addMonthsDn_(cur, -i);
    months.push({ start: s, end: addMonthsDn_(s, 1) - 1, label: ymd_(s).y + '/' + pad2_(ymd_(s).m) });
  }
  var used = function (p, M) {
    return isValidSpan_(p) && p.intro <= today && p.intro <= M.end && (p.exit === null || p.exit > M.start);
  };
  var billable = function (p, M, cb) {
    return used(p, M) && !(cb && cb.freeFirst && p.intro >= M.start && p.intro <= M.end);
  };
  var comboOf = function (p) { return master.combo[comboKey_(p.device, p.supplier)] || null; };
  var lastM = months[22];
  var thisM = months[23];

  var comboRows = [];
  master.combos.forEach(function (cb) {
    if (!cb.device || !cb.supplier) return;
    var mine = patients.filter(function (p) { return p.device === cb.device && p.supplier === cb.supplier; });
    var a = mine.filter(function (p) { return billable(p, lastM, cb); }).length;
    var b = mine.filter(function (p) { return billable(p, thisM, cb); }).length;
    var money = function (n) { return cb.price === null ? '' : n * cb.price; };
    comboRows.push([cb.device, cb.supplier, cb.price === null ? '' : cb.price, cb.freeFirst ? 'あり' : 'なし',
                    a, money(a), b, money(b)]);
  });
  var unknown = patients.filter(function (p) { return !comboOf(p); });
  var ua = unknown.filter(function (p) { return used(p, lastM); }).length;
  var ub = unknown.filter(function (p) { return used(p, thisM); }).length;
  if (ua || ub) comboRows.push(['（マスタにない組み合わせ）', '', '', '', ua, '', ub, '']);
  var total = ['合計', '', '', '', 0, 0, 0, 0];
  comboRows.forEach(function (r) {
    [4, 5, 6, 7].forEach(function (i) { if (typeof r[i] === 'number') total[i] += r[i]; });
  });
  var unpriced = master.combos.filter(function (cb) {
    return cb.device && cb.supplier && cb.price === null && patients.some(function (p) {
      return p.device === cb.device && p.supplier === cb.supplier && (used(p, lastM) || used(p, thisM));
    });
  }).map(function (cb) { return cb.device + '（' + cb.supplier + '）'; });

  var suppliers = master.suppliers.slice();
  patients.forEach(function (p) {
    var s2 = supOf_(p);
    if (suppliers.indexOf(s2) < 0) suppliers.push(s2);
  });
  suppliers = suppliers.filter(function (s2) {
    return patients.some(function (p) { return supOf_(p) === s2; });
  });
  var monthly = months.slice().reverse().map(function (M) {
    var row = [M.label];
    var allN = 0;
    var allYen = 0;
    suppliers.forEach(function (s2) {
      var n = 0;
      var yen = 0;
      patients.forEach(function (p) {
        if (supOf_(p) !== s2) return;
        var cb = comboOf(p);
        if (!billable(p, M, cb)) return;
        n++;
        if (cb && cb.price !== null) yen += cb.price;
      });
      row.push(n, yen);
      allN += n;
      allYen += yen;
    });
    row.push(allN, allYen);
    return row;
  });
  return {
    lastLabel: lastM.label, thisLabel: thisM.label,
    comboRows: comboRows.length ? comboRows.concat([total]) : [],
    unpriced: unpriced, suppliers: suppliers, monthly: monthly
  };
}


// ============================================================
// 書き出し：ダッシュボード
// ============================================================
var DASH_W = [150, 75, 75, 75, 75, 24, 90, 60, 140, 130, 130];   // A〜K

function writeDashboard_(ctx, lists, periods, checks) {
  var sh = outputSheet_('dash');
  resetSheet_(sh);
  var st = dashboardStats_(ctx.patients, ctx.today, lists);
  var k = st.kpi;
  ensureSize_(sh, 90 + st.byDevice.length + st.bySupplier.length + checks.length, 26);
  sh.setHiddenGridlines(true);
  DASH_W.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  title_(sh, 'CPAP 患者管理ダッシュボード', '更新：' + ctx.stamp + '　（入力から' + AUTO_REFRESH_MINUTES +
    '分ほどで自動更新。すぐ反映するには メニュー［CPAP管理］→［集計を今すぐ更新］）');

  cards_(sh, 4, [
    { col: 1, span: 1, label: '現在の利用者', value: k.active, sub: '先月末 ' + k.activeLastMonthEnd + '人' },
    { col: 2, span: 2, label: '今月の導入', value: k.introThisMonth, sub: '先月 ' + k.introLastMonth + '人' },
    { col: 4, span: 2, label: '今月の離脱', value: k.exitThisMonth, sub: '先月 ' + k.exitLastMonth + '人' },
    { col: 7, span: 2, label: '今週の導入', value: k.introThisWeek, sub: '先週 ' + k.introLastWeek + '人' },
    { col: 9, span: 1, label: '累計（登録者）', value: k.total, sub: 'うち離脱 ' + k.totalExit + '人' },
    { col: 10, span: 1, label: '対象（○）', value: k.marked,
      sub: k.markedNoPeriod ? 'うち期間なし ' + k.markedNoPeriod + '人' : (k.marked ? '全員に期間あり' : '') },
    { col: 11, span: 1, label: '1年継続率', value: k.ret1y.rate === null ? '—' : k.ret1y.rate, format: '0%',
      sub: k.ret1y.den ? k.ret1y.den + '人中 ' + k.ret1y.num + '人' : '対象者なし' }
  ]);

  var rowL = boxTable_(sh, 8, 1, '機器別（いま）', ['機器', '利用中', '今月の導入', '離脱', '累計'], st.byDevice,
    { formats: [null, '#,##0', '#,##0', '#,##0', '#,##0'], total: true, empty: '患者がまだいません' });
  rowL = boxTable_(sh, rowL + 1, 1, '業者別（いま）', ['業者', '利用中', '今月の導入', '離脱', '累計'], st.bySupplier,
    { formats: [null, '#,##0', '#,##0', '#,##0', '#,##0'], total: true, empty: '患者がまだいません' });
  var rowR = boxTable_(sh, 8, 7, '直近の導入（10件）', ['導入日', 'ID', '機器', '業者', '状態'], st.recentIntro,
    { formats: ['yyyy/mm/dd'], center: [1, 4], empty: '導入日が入った人がまだいません' });
  rowR = boxTable_(sh, rowR + 1, 7, '直近の離脱（10件）', ['離脱日', 'ID', '機器', '離脱理由', '利用期間'], st.recentExit,
    { formats: ['yyyy/mm/dd'], center: [1], empty: '離脱した人はいません' });

  var row = writeChecks_(sh, Math.max(rowL, rowR) + 1, checks, ctx.sheet.getSheetId());
  writeDashCharts_(sh, row + 1, periods, st);
}

/** 入力チェックの結果（行番号はクリックで患者一覧のその行へ） */
function writeChecks_(sh, row, checks, gid) {
  var W = 11;
  sh.getRange(row, 1, 1, W).setBackground(C_SECTION);
  sh.getRange(row, 1).setValue('要確認（入力チェック）　行番号をクリックすると、患者一覧のその行へ移動します')
    .setFontWeight('bold').setFontColor('#ffffff');
  row++;
  var issues = checks.filter(function (x) { return x.items.length; });
  if (!issues.length) {
    sh.getRange(row, 1, 1, W).setBackground(C_OK);
    sh.getRange(row, 1).setValue('✓ 問題は見つかりませんでした').setFontColor(C_OK_FONT).setFontWeight('bold');
    return row + 1;
  }
  var top = row;
  issues.forEach(function (x) {
    var bg = x.level === 'error' ? C_ALERT : (x.level === 'warn' ? C_WARN : '#f3f3f3');
    sh.getRange(row, 1, 1, W).setBackground(bg).setVerticalAlignment('top');
    sh.getRange(row, 1, 1, 3).merge().setValue(x.label).setFontWeight('bold').setWrap(true);
    var real = x.items.filter(function (it) { return it.row > 0; });
    sh.getRange(row, 4).setValue(real.length ? real.length + '件' : '').setHorizontalAlignment('center');
    sh.getRange(row, 5, 1, W - 4).merge().setWrap(true);
    var links = rowLinks_(real, gid, 30);
    if (links) sh.getRange(row, 5).setRichTextValue(links);
    // 結合したセルは行の高さが自動で伸びないので、文字数から高さを決める
    var lines = Math.max(textLines_(x.label, 42), links ? textLines_(links.getText(), 88) : 1);
    sh.setRowHeight(row, lines * 17 + 5);
    row++;
  });
  sh.getRange(top, 1, row - top, W).setBorder(true, true, true, true, null, true, C_BORDER,
    SpreadsheetApp.BorderStyle.SOLID);
  return row;
}

function rowLinks_(items, gid, max) {
  if (!items.length) return null;
  var text = '';
  var links = [];
  items.slice(0, max).forEach(function (it, i) {
    var label = it.row + '行目' + (it.id ? '(ID ' + it.id + ')' : '');
    if (i) text += '、';
    links.push([text.length, text.length + label.length, '#gid=' + gid + '&range=A' + it.row]);
    text += label;
  });
  if (items.length > max) text += '　ほか' + (items.length - max) + '件';
  var b = SpreadsheetApp.newRichTextValue().setText(text);
  links.forEach(function (l) { b.setLinkUrl(l[0], l[1], l[2]); });
  return b.build();
}

/** ダッシュボードのグラフ（元データは隠し列 M〜X に置く） */
function writeDashCharts_(sh, row, periods, st) {
  var months = periods.month.rows.slice(0, 12).reverse();
  var weeks = periods.week.rows.slice(0, 12).reverse();
  var supRows = st.bySupplier.filter(function (r) { return r[0] !== '合計' && r[1] > 0; })
    .map(function (r) { return [r[0], r[1]]; });
  ensureSize_(sh, row + 32, 26);
  sh.getRange(1, 13).setValue('グラフ用（自動）');
  var block = function (col, head, rows) {
    sh.getRange(2, col, 1, head.length).setValues([head]);
    if (rows.length) sh.getRange(3, col, rows.length, head.length).setValues(rows);
    return sh.getRange(2, col, rows.length + 1, head.length);
  };
  var rMonth = block(13, ['月', '導入数', '離脱数'], months.map(function (x) { return [x.short, x.intro, x.exit]; }));
  var rActive = block(17, ['月', '月末の利用者数'], months.map(function (x) { return [x.short, x.active]; }));
  var rWeek = block(20, ['週', '導入数'], weeks.map(function (x) { return [x.short, x.intro]; }));
  var rSup = block(23, ['業者', '利用中'], supRows);
  sh.hideColumns(12, 13);

  if (!months.length) {
    sh.getRange(row, 1).setValue('導入日が入ると、ここにグラフが出ます。').setFontColor('#808080');
    return;
  }
  var h = 280;
  var gap = 15;
  chart_(sh, 'column', rMonth, { row: row, col: 1, width: 460, height: h,
    title: '月別の導入数・離脱数（直近12ヶ月）', colors: [C_BLUE, C_RED] });
  chart_(sh, 'line', rActive, { row: row, col: 7, width: 520, height: h,
    title: '利用者数の推移（月末時点・直近12ヶ月）', colors: [C_BLUE], legend: 'none' });
  chart_(sh, 'column', rWeek, { row: row + gap, col: 1, width: 460, height: h,
    title: '週別の導入数（直近12週）', colors: [C_BLUE], legend: 'none' });
  if (supRows.length) {
    chart_(sh, 'pie', rSup, { row: row + gap, col: 7, width: 520, height: h, title: '業者別の利用中の人数' });
  }
}


// ============================================================
// 書き出し：月別・週別・年別
// ============================================================
var PERIOD_CFG = {
  month: { title: '月別の推移', label: '月', unit: '月', endHead: '月末の利用者数', width: 90 },
  week:  { title: '週別の推移', label: '週（月曜〜日曜）', unit: '週', endHead: '週末の利用者数', width: 170 },
  year:  { title: '年別の推移', label: '年', unit: '年', endHead: '年末の利用者数', width: 80 }
};

function writePeriodSheet_(kind, ctx, lists, table) {
  var cfg = PERIOD_CFG[kind];
  var sh = outputSheet_(kind);
  resetSheet_(sh);
  sh.setHiddenGridlines(true);
  title_(sh, cfg.title, '導入日・離脱日で数えています（新しい順）。今' + cfg.unit +
    'は今日までの数、利用者数は今日時点です。　更新：' + ctx.stamp);
  var rows = table.rows;
  if (!rows.length) {
    sh.getRange('A4').setValue('導入日が入った利用者がまだいません。').setFontColor('#808080');
    return;
  }
  var devs = lists.devices;
  var sups = lists.suppliers;
  var cDev = 8;
  var cSup = cDev + devs.length + 1;
  var width = cSup + sups.length - 1;
  var top = 6;
  ensureSize_(sh, top + rows.length + 25, width + 1);

  group_(sh, 4, 2, 5, '全体');
  group_(sh, 4, cDev, devs.length, '機器別の導入数');
  group_(sh, 4, cSup, sups.length, '業者別の導入数');
  var head = [cfg.label, '導入数', '離脱数', '純増', cfg.endHead, '導入数のグラフ', ''].concat(devs)
    .concat(['']).concat(sups);
  sh.getRange(5, 1, 1, width).setValues([head]);
  headStyle_(sh.getRange(5, 1, 1, 6));
  headStyle_(sh.getRange(5, cDev, 1, devs.length));
  headStyle_(sh.getRange(5, cSup, 1, sups.length));
  sh.setRowHeight(5, 36);

  var body = rows.map(function (x) {
    return [x.label, x.intro, x.exit, x.net, x.active, '', ''].concat(x.byDevice).concat(['']).concat(x.bySupplier);
  });
  sh.getRange(top, 1, body.length, width).setValues(body);
  var max = rows.reduce(function (m, x) { return Math.max(m, x.intro); }, 1);
  sh.getRange(top, 6, body.length, 1).setFormulas(rows.map(function (x, i) {
    return ['=SPARKLINE(B' + (top + i) + ',{"charttype","bar";"max",' + max + ';"color1","' + C_BLUE + '"})'];
  }));
  sh.getRange(top, 2, body.length, 4).setNumberFormat('#,##0').setHorizontalAlignment('center');
  sh.getRange(top, 4, body.length, 1).setNumberFormat('+#,##0;-#,##0;0');
  sh.getRange(top, cDev, body.length, devs.length).setNumberFormat('#,##0;-#,##0;"-"').setHorizontalAlignment('center');
  sh.getRange(top, cSup, body.length, sups.length).setNumberFormat('#,##0;-#,##0;"-"').setHorizontalAlignment('center');
  [[1, 6], [cDev, devs.length], [cSup, sups.length]].forEach(function (blk) {
    sh.getRange(top, blk[0], body.length, blk[1]).setBorder(true, true, true, true, true, true, C_BORDER,
      SpreadsheetApp.BorderStyle.SOLID);
  });
  rows.forEach(function (x, i) {
    if (!x.isCurrent) return;
    [[1, 6], [cDev, devs.length], [cSup, sups.length]].forEach(function (blk) {
      sh.getRange(top + i, blk[0], 1, blk[1]).setBackground(C_NOW).setFontWeight('bold');
    });
  });

  sh.setColumnWidth(1, cfg.width);
  [2, 3, 4].forEach(function (cc) { sh.setColumnWidth(cc, 64); });
  sh.setColumnWidth(5, 104);
  sh.setColumnWidth(6, 130);
  sh.setColumnWidth(7, 16);
  for (var i = 0; i < devs.length; i++) sh.setColumnWidth(cDev + i, 104);
  sh.setColumnWidth(cSup - 1, 16);
  for (var j = 0; j < sups.length; j++) sh.setColumnWidth(cSup + j, 104);
  sh.setFrozenRows(5);
  sh.setFrozenColumns(1);

  if (kind === 'year') {
    chart_(sh, 'column', sh.getRange(5, 1, rows.length + 1, 3), {
      row: top + rows.length + 2, col: 1, width: 560, height: 300, reverse: true,
      title: '年別の導入数・離脱数', colors: [C_BLUE, C_RED] });
  }
}

function group_(sh, row, col, width, text) {
  if (width < 1) return;
  var r = sh.getRange(row, col, 1, width);
  if (width > 1) r.merge();
  r.setValue(text).setBackground(C_SECTION).setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center');
}


// ============================================================
// 書き出し：機器別一覧
// ============================================================
var DEVICE_SEL = 'C3:G3';   // クラウド・機器・業者・状態・対象 を選ぶ黄色のセル
var MARK_ONLY = TARGET_MARK + 'のみ';
var MARK_NONE = TARGET_MARK + 'なし';

/** 機器別一覧：クラウド・機器ごとに、レポートを出す人と期間を確かめる作業用の一覧 */
function writeDeviceList_(ctx, lists) {
  var sh = outputSheet_('device');
  var prev = sh.getLastRow() >= 3 ? sh.getRange(DEVICE_SEL).getDisplayValues()[0] : [];
  var clOpts = [ALL_OPTION].concat(lists.clouds);
  var devOpts = [ALL_OPTION].concat(lists.devices);
  var supOpts = [ALL_OPTION].concat(lists.suppliers);
  var stOpts = [STATUS_ACTIVE, STATUS_EXIT, ALL_OPTION];
  var mkOpts = [ALL_OPTION, MARK_ONLY, MARK_NONE];
  var pick = function (opts, v, def) { return opts.indexOf(v) >= 0 ? v : def; };
  var selCl = pick(clOpts, prev[0], ALL_OPTION);
  var selDev = pick(devOpts, prev[1], ALL_OPTION);
  var selSup = pick(supOpts, prev[2], ALL_OPTION);
  var selSt = pick(stOpts, prev[3], STATUS_ACTIVE);
  var selMk = pick(mkOpts, prev[4], ALL_OPTION);

  resetSheet_(sh);
  sh.setHiddenGridlines(true);
  [60, 130, 130, 150, 140, 70, 70, 105, 105, 95, 85, 240].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange('A1').setValue('機器別一覧').setFontSize(15).setFontWeight('bold').setFontColor(C_TITLE);
  sh.getRange('C2:G2').setValues([['クラウド区分', '機器', '業者', '状態', '対象']]).setFontSize(9).setFontWeight('bold')
    .setFontColor(C_SUB);
  sh.getRange(DEVICE_SEL).setValues([[selCl, selDev, selSup, selSt, selMk]]).setBackground(C_INPUT).setFontWeight('bold')
    .setBorder(true, true, true, true, true, null, '#bf9000', SpreadsheetApp.BorderStyle.SOLID);
  var rule = function (opts) {
    return SpreadsheetApp.newDataValidation().requireValueInList(opts, true).setAllowInvalid(false).build();
  };
  sh.getRange('C3').setDataValidation(rule(clOpts));
  sh.getRange('D3').setDataValidation(rule(devOpts));
  sh.getRange('E3').setDataValidation(rule(supOpts));
  sh.getRange('F3').setDataValidation(rule(stOpts));
  sh.getRange('G3').setDataValidation(rule(mkOpts));
  sh.getRange('H2').setValue('← 黄色のセルを選ぶと切り替わります').setFontSize(9).setFontColor(C_SUB);

  var pool = ctx.patients.filter(function (p) {
    return (selCl === ALL_OPTION || clOf_(p) === selCl) && (selDev === ALL_OPTION || devOf_(p) === selDev) &&
      (selSup === ALL_OPTION || supOf_(p) === selSup);
  });
  var t = ymd_(ctx.today);
  var mStart = dn_(t.y, t.m, 1);
  var count = function (fn) { return pool.filter(fn).length; };
  sh.getRange('A4').setValue('利用中 ' + count(function (p) { return p.status === STATUS_ACTIVE; }) + '人／離脱 ' +
    count(function (p) { return p.status === STATUS_EXIT; }) + '人／累計 ' + pool.length + '人／今月の導入 ' +
    count(function (p) { return p.intro !== null && p.intro >= mStart && p.intro <= ctx.today; }) + '人／対象（○） ' +
    count(function (p) { return p.target; }) + '人　　（更新：' + ctx.stamp + '）').setFontWeight('bold').setFontColor(C_TITLE);

  var list = pool.filter(function (p) {
    return (selSt === ALL_OPTION || p.status === selSt) &&
      (selMk === ALL_OPTION || (selMk === MARK_ONLY ? p.target : !p.target));
  });
  var order = function (arr, v) { var i = arr.indexOf(v); return i < 0 ? 999 : i; };
  list.sort(function (a, b) {
    return (order(lists.clouds, clOf_(a)) - order(lists.clouds, clOf_(b))) ||
      (order(lists.devices, devOf_(a)) - order(lists.devices, devOf_(b))) ||
      (order(lists.suppliers, supOf_(a)) - order(lists.suppliers, supOf_(b))) || compareId_(a, b);
  });
  var head = ['ID', '名前', 'クラウド区分', '機器', '業者', '状態', '対象', 'レポート開始日', 'レポート終了日', '導入日',
              '利用期間', '備考'];
  ensureSize_(sh, list.length + 10, head.length);
  var rows = list.map(function (p) {
    var until = p.exit !== null && p.exit <= ctx.today ? p.exit : ctx.today;
    return [p.id, p.name, p.cloud, p.device, p.supplier, p.status, p.target ? TARGET_MARK : '', p.raw.repStart,
            p.raw.repEnd, p.raw.intro,
            durationText_(p.intro !== null && p.intro <= until ? monthsBetween_(p.intro, until) : null), p.note];
  });
  var end = table_(sh, 5, 1, head, rows, {
    formats: [null, null, null, null, null, null, null, 'yyyy/mm/dd', 'yyyy/mm/dd', 'yyyy/mm/dd'], center: [0, 5, 6],
    empty: '該当する人はいません' });
  if (rows.length) {
    var bg = list.map(function (p) {
      var line = [];
      for (var i = 0; i < head.length; i++) line.push(p.status === STATUS_EXIT ? C_EXIT_BG : null);
      if (p.repStart !== null && p.repEnd !== null && p.repEnd < p.repStart) {
        line[7] = C_ALERT;
        line[8] = C_ALERT;
      } else if (p.target && (p.repStart === null || p.repEnd === null)) {
        line[7] = C_TODO;
        line[8] = C_TODO;
      }
      if (p.target && p.status === STATUS_EXIT) line[6] = C_WARN;
      return line;
    });
    sh.getRange(6, 1, rows.length, head.length).setBackgrounds(bg);
    sh.getRange(6, 7, rows.length, 1).setFontWeight('bold');
    sh.getRange(end, 1).setValue('水色：対象（○）なのにレポート期間が空欄　赤：終了日が開始日より前　オレンジ：離脱しているのに○')
      .setFontSize(9).setFontColor(C_SUB);
  }
  sh.setFrozenRows(5);
}


// ============================================================
// 書き出し：離脱分析
// ============================================================
function writeExitSheet_(ctx, lists) {
  var sh = outputSheet_('exit');
  resetSheet_(sh);
  sh.setHiddenGridlines(true);
  [150, 90, 90, 90, 90, 130, 140].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  var st = exitStats_(ctx.patients, ctx.today, lists, ctx.master.reasons);
  var k = st.kpi;
  title_(sh, '離脱分析', '状態が「離脱」の人をもとに集計しています。利用期間は導入日から離脱日まで。　更新：' + ctx.stamp);
  cards_(sh, 4, [
    { col: 1, span: 1, label: '累計の離脱', value: k.total,
      sub: k.rate === null ? '' : '登録者の ' + Math.round(k.rate * 100) + '%' },
    { col: 2, span: 2, label: '今年の離脱', value: k.thisYear, sub: ymd_(ctx.today).y + '年' },
    { col: 4, span: 2, label: '3ヶ月以内の離脱', value: k.early,
      sub: k.dated ? '日付のある離脱 ' + k.dated + '人のうち ' + Math.round(k.early / k.dated * 100) + '%' : '' },
    { col: 6, span: 2, label: '離脱までの平均', value: k.avgMonths === null ? '—' : durationText_(Math.round(k.avgMonths)),
      format: '@', sub: '導入日から離脱日まで' }
  ]);
  ensureSize_(sh, 60 + st.list.length + st.cohorts.length + st.reasons.length + lists.devices.length, 16);

  var row = boxTable_(sh, 8, 1, '離脱理由別', ['離脱理由', '人数', '割合', '今年'], st.reasons,
    { formats: [null, '#,##0', '0%', '#,##0'], center: [1, 2, 3], empty: '離脱した人はいません' });
  if (st.reasons.length) {
    chart_(sh, 'pie', sh.getRange(9, 1, st.reasons.length + 1, 2), { row: 8, col: 9, width: 440, height: 280,
      title: '離脱理由の割合' });
  }
  row = boxTable_(sh, row + 1, 1, '利用期間別（導入してから離脱するまで）', ['期間', '人数', '割合'], st.durations,
    { formats: [null, '#,##0', '0%'], center: [1, 2] });
  row = boxTable_(sh, row + 1, 1, '導入年ごとの継続率（その期間がたった人のうち、続けていた人）',
    ['導入年', '導入数', '3ヶ月', '1年', '2年', '今も利用中'], st.cohorts,
    { formats: [null, '#,##0', null, null, null, '#,##0'], center: [1, 2, 3, 4, 5], empty: '導入日が入った人がまだいません' });
  row = boxTable_(sh, row + 1, 1, '機器別の離脱', ['機器', '登録', '離脱', '離脱率', '3ヶ月以内', '平均の利用期間'],
    st.byDevice, { formats: [null, '#,##0', '#,##0', '0%', '#,##0'], center: [1, 2, 3, 4, 5] });
  boxTable_(sh, row + 1, 1, '離脱した人の一覧（新しい順）',
    ['機器', '離脱日', 'ID', '導入日', '利用期間', '業者', '離脱理由'], st.list,
    { formats: [null, 'yyyy/mm/dd', null, 'yyyy/mm/dd'], center: [2, 4], empty: '離脱した人はいません' });
}


// ============================================================
// 書き出し：台数・費用
// ============================================================
function writeCostSheet_(ctx) {
  var sh = outputSheet_('cost');
  resetSheet_(sh);
  sh.setHiddenGridlines(true);
  var st = costStats_(ctx.patients, ctx.master, ctx.today);
  title_(sh, '台数・費用（目安）', 'その月に1日でも利用があった台数で数えています（初月無料「あり」の組み合わせは、導入した月を数えません）。' +
    '業者からの請求の確認にお使いください。　更新：' + ctx.stamp);
  var width = 1 + st.suppliers.length * 2 + 2;
  ensureSize_(sh, st.comboRows.length + st.monthly.length + 20, Math.max(width, 8) + 1);
  [160, 140, 100, 70, 90, 100, 90, 100].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  var row = boxTable_(sh, 4, 1, '組み合わせ別（先月・今月）',
    ['機器', '業者', '月額（税込）', '初月無料', st.lastLabel + ' 台数', st.lastLabel + ' 金額',
     st.thisLabel + ' 台数', st.thisLabel + ' 金額'], st.comboRows,
    { formats: [null, null, '#,##0', null, '#,##0', '#,##0"円"', '#,##0', '#,##0"円"'], center: [3, 4, 6],
      total: true, empty: '［マスタ］に機器と業者の組み合わせがありません' });
  if (st.unpriced.length) {
    sh.getRange(row, 1).setValue('※ 月額が未入力のため金額に入っていないもの：' + st.unpriced.join('、') +
      '（［マスタ］に月額を入れてください）').setFontSize(9).setFontColor(C_ALERT_FONT);
    row++;
  }
  row += 1;

  if (!st.suppliers.length) return;
  var W = width;
  sh.getRange(row, 1, 1, W).setBackground(C_SECTION);
  sh.getRange(row, 1).setValue('業者別・月ごと（直近24ヶ月・新しい順）').setFontWeight('bold').setFontColor('#ffffff');
  row++;
  sh.getRange(row, 1, 2, 1).merge().setValue('月');
  st.suppliers.forEach(function (s, i) {
    sh.getRange(row, 2 + i * 2, 1, 2).merge().setValue(s);
    sh.getRange(row + 1, 2 + i * 2, 1, 2).setValues([['台数', '金額']]);
  });
  sh.getRange(row, W - 1, 1, 2).merge().setValue('合計');
  sh.getRange(row + 1, W - 1, 1, 2).setValues([['台数', '金額']]);
  headStyle_(sh.getRange(row, 1, 2, W));
  var body = sh.getRange(row + 2, 1, st.monthly.length, W);
  body.setValues(st.monthly).setBorder(true, true, true, true, true, true, C_BORDER,
    SpreadsheetApp.BorderStyle.SOLID);
  for (var c = 2; c <= W; c++) {
    sh.getRange(row + 2, c, st.monthly.length, 1).setNumberFormat(c % 2 === 0 ? '#,##0' : '#,##0"円";-#,##0"円";"-"');
    if (c > 8) sh.setColumnWidth(c, c % 2 === 0 ? 70 : 100);
  }
  sh.getRange(row + 2, 1, 1, W).setBackground(C_NOW).setFontWeight('bold');
}


// ============================================================
// 書き出し：匿名データ（名前・備考を除いた一覧）
// ============================================================
function writeAnonSheet_(ctx) {
  var sh = outputSheet_('anon');
  resetSheet_(sh);
  var head = ['ID', '機器', '業者', 'クラウド', '導入日', '離脱日', '状態', '離脱理由', '利用月数',
              'レポート開始日', 'レポート終了日', '対象'];
  sh.getRange('A1').setValue('匿名データ（名前・備考を除いた一覧）').setFontSize(14).setFontWeight('bold')
    .setFontColor(C_TITLE);
  sh.getRange('A2').setValue('外部での分析やAIに渡すときはこのタブを使ってください。集計の更新のたびに作り直します。　更新：' +
    ctx.stamp).setFontSize(9).setFontColor(C_SUB);
  var rows = ctx.patients.map(function (p) {
    var info = ctx.master.info[p.device];
    var until = p.exit !== null && p.exit <= ctx.today ? p.exit : ctx.today;
    var months = p.intro !== null && p.intro <= until ? monthsBetween_(p.intro, until) : '';
    return [p.id, p.device, p.supplier, p.cloud || (info ? info.cloud : ''), p.raw.intro, p.raw.exit, p.status, p.reason,
            months === null ? '' : months, p.raw.repStart, p.raw.repEnd, p.target ? TARGET_MARK : ''];
  });
  ensureSize_(sh, rows.length + 5, head.length);
  table_(sh, 4, 1, head, rows, {
    formats: [null, null, null, null, 'yyyy/mm/dd', 'yyyy/mm/dd', null, null, '#,##0', 'yyyy/mm/dd', 'yyyy/mm/dd'],
    center: [11], empty: '患者がまだいません' });
  sh.setFrozenRows(4);
  [60, 150, 140, 130, 95, 95, 60, 120, 70, 105, 105, 50].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}


// ============================================================
// 書き出し：使い方
// ============================================================
function writeGuide_() {
  var sh = outputSheet_('guide');
  resetSheet_(sh);
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 760);
  var lines = [
    ['h1', 'CPAP 患者管理 ─ 使い方'],
    ['p', '入力するのは「' + SH.ledger + '」と「' + SH.master + '」の2つだけです。ほかのタブは自動で作られます' +
          '（直接書き込んでも、次の更新で上書きされます）。'],
    ['h2', '毎日の入力（' + SH.ledger + '）'],
    ['li', '新しい患者さん：メニュー［CPAP管理］→［新規登録フォーム］で登録するか、' + SH.ledger + 'のいちばん下の行に直接入力します。'],
    ['li', '名前を入れると、ID（数字のIDの場合）と状態「利用中」が自動で入ります。'],
    ['li', '機器を選ぶと、クラウド区分（AirView・InfoSmart など）が自動で入ります。業者が1社だけの機器は業者も自動で入ります。業者が複数ある機器（AirSense10 など）は業者を選んでください。'],
    ['li', 'やめたとき：離脱日を入れると、状態が自動で「離脱」になり、対象の○が外れて、行がグレーになります。離脱理由も選んでください。'],
    ['li', '日付は「t」で今日、「y」で昨日。「20261001」「R8.10.1」「10/1」でも入ります。セルをダブルクリックするとカレンダーが出ます。'],
    ['li', '一度やめて再開した人は、新しい行で登録し、備考に前のIDを書いてください（導入数・離脱数が正しく数えられます）。'],
    ['li', 'やめた人の行は削除せずに残してください（過去の集計が変わってしまうため）。'],
    ['h2', 'レポートを出すとき（対象・レポート期間）'],
    ['li', 'レポートを出す人の「対象」に「○」を入れ、「レポート開始日」「レポート終了日」に期間を入れます。' +
           '対象の欄は何を入れても○になります（×・0 は空欄に）。新規登録した人は最初から○です。'],
    ['li', 'まとめて入れるとき：' + SH.ledger + 'で行を選び（見出しの▼で機器などを絞り込んでから選ぶと便利）、' +
           'メニュー［CPAP管理］→［レポート（期間・対象○）をまとめて入力］。'],
    ['li', '期間は「先月」「今月」「前回の続き（前回の終了日の翌日から）」「日付を指定」から選べ、同時に○も付けられます。' +
           '○だけを付ける・外すこともできます。離脱した人と、絞り込みで隠れている行には入りません。'],
    ['li', '「' + SH.device + '」タブでクラウド区分を選び、「対象」を「○のみ」にすると、そのクラウドでレポートを出す人と期間の一覧になります。'],
    ['li', 'レポートを出し終わったら、メニュー［CPAP管理］→［対象（○）をすべて消す］で○をまとめて空欄に戻します（期間は残ります）。'],
    ['h2', '自動で作られるタブ'],
    ['tbl', SH.dash, 'いまの利用者数、今月・今週の導入と離脱、機器別・業者別の人数、直近の導入・離脱、要確認（入力もれ）、グラフ'],
    ['tbl', SH.month + '／' + SH.week + '／' + SH.year, '期間ごとの導入数・離脱数・純増・期末の利用者数と、機器別・業者別の導入数（新しい順）'],
    ['tbl', SH.device, 'クラウド区分・機器・業者・状態・対象を選ぶと、その人たちの一覧（対象○・レポート期間つき）が出ます'],
    ['tbl', SH.exit, '離脱理由・利用期間・機器ごとの離脱、導入年ごとの継続率（3ヶ月・1年・2年）、離脱した人の一覧'],
    ['tbl', SH.cost, '業者ごと・月ごとの利用台数と、レンタル料の目安（［マスタ］に月額を入れた場合）'],
    ['tbl', SH.anon, '名前と備考を除いた一覧（メニューから作成）。外部での分析やAIに渡すときはこちらを使ってください'],
    ['li', '入力してから' + AUTO_REFRESH_MINUTES + '分ほどで自動更新されます。すぐ反映したいときはメニュー［CPAP管理］→［集計を今すぐ更新］。'],
    ['h2', SH.master],
    ['li', '機器と業者の組み合わせを1行ずつ入れます。ここにある機器・業者・離脱理由が、' + SH.ledger + 'のドロップダウンの候補になります。'],
    ['li', '「月額レンタル料（税込）」と「初月無料（あり／なし）」を入れると、「' + SH.cost + '」タブで金額の目安が出ます。'],
    ['h2', '色の意味（' + SH.ledger + '）'],
    ['color', C_ALERT, '赤：直してほしいもの（入力もれ・IDの重複・日付として読めない・日付の前後が逆）'],
    ['color', C_WARN, 'オレンジ：確認してほしいもの（同じ名前が複数・「離脱」なのに離脱日や離脱理由が空欄、または○が付いている）'],
    ['color', C_TODO, '水色：対象（○）なのにレポート期間が入っていない'],
    ['color', C_EXIT_BG, 'グレー：離脱した人'],
    ['h2', '注意'],
    ['li', '1行目の見出しの名前と、タブの名前は変えないでください。右に列を足すのは大丈夫です。'],
    ['li', '列を並べ替えたときや、色分け・ドロップダウンがおかしいときは、メニュー［CPAP管理］→［管理・設定］→' +
           '［初期セットアップ／修復］を実行してください。入力済みのデータは消えません。'],
    ['li', '自動更新は、セットアップした人のアカウントで動きます。その人がこのファイルを使えなくなったら、' +
           '別の人が［自動更新をオンにする］を実行してください。'],
    ['p', 'CPAP管理スクリプト v' + APP_VERSION]
  ];
  ensureSize_(sh, lines.length + 5, 2);
  lines.forEach(function (ln, i) {
    var row = i + 1;
    var kind = ln[0];
    var both = sh.getRange(row, 1, 1, 2);
    if (kind === 'tbl') {
      sh.getRange(row, 1).setValue(ln[1]).setFontWeight('bold').setBackground(C_CARD).setVerticalAlignment('top');
      sh.getRange(row, 2).setValue(ln[2]).setWrap(true);
      both.setBorder(true, true, true, true, true, null, C_BORDER, SpreadsheetApp.BorderStyle.SOLID);
      sh.setRowHeight(row, textLines_(ln[2], 108) * 17 + 5);
      return;
    }
    if (kind === 'color') {
      sh.getRange(row, 1).setBackground(ln[1]);
      sh.getRange(row, 2).setValue(ln[2]);
      return;
    }
    var text = kind === 'li' ? '・' + ln[1] : ln[1];
    both.merge().setValue(text).setWrap(true).setVerticalAlignment('middle');
    sh.setRowHeight(row, textLines_(text, 134) * 17 + 5);
    if (kind === 'h1') {
      both.setFontSize(16).setFontWeight('bold').setFontColor(C_TITLE);
      sh.setRowHeight(row, 36);
    } else if (kind === 'h2') {
      both.setFontWeight('bold').setBackground(C_SECTION).setFontColor('#ffffff');
      sh.setRowHeight(row, 26);
    } else if (kind === 'p' && i === lines.length - 1) {
      both.setFontSize(9).setFontColor(C_SUB);
    }
  });
}


// ============================================================
// 自動更新（時間主導のトリガー）
// ============================================================
function enableAutoRefresh() {
  withUi_(function () {
    installAutoRefresh_();
    SpreadsheetApp.getUi().alert('自動更新をオンにしました。入力から' + AUTO_REFRESH_MINUTES +
      '分ほどで集計が更新されます（変更がないときは何もしません）。');
  });
}

function disableAutoRefresh() {
  withUi_(function () {
    var n = removeAppTriggers_();
    SpreadsheetApp.getUi().alert(n ? '自動更新をオフにしました。集計はメニューの［集計を今すぐ更新］で更新してください。'
                                   : '（このアカウントでは）自動更新は設定されていませんでした。');
  });
}

function installAutoRefresh_() {
  removeAppTriggers_();
  ScriptApp.newTrigger('autoRefresh').timeBased().everyMinutes(AUTO_REFRESH_MINUTES).create();
}

function removeAppTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'autoRefresh' || h === 'dailyRefresh') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

/** トリガーから呼ばれる。患者一覧・マスタ・日付が前回から変わったときだけ集計し直す */
function autoRefresh() {
  try {
    var ctx = loadContext_();
    var last = PropertiesService.getDocumentProperties().getProperty('lastSig');
    if (last && last === signature_(ctx)) return;
    refreshAll_({ ctx: ctx, wait: 1000 });
  } catch (err) {
    if (err && err.name === 'ConfigError') return;   // タブがない等は、セットアップされるまで静かに待つ
    throw err;
  }
}

/** 旧バージョンの毎日トリガー（dailyRefresh）が残っていても動くように */
function dailyRefresh() {
  refreshAll_({ wait: 30000 });
}

function signature_(ctx) {
  var s = JSON.stringify([APP_VERSION, ctx.today, ctx.values, ctx.master.raw]);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}


// ============================================================
// 旧バージョン（v17まで）からの取り込み・旧タブの片付け
// ============================================================
function importOldData() {
  withUi_(function () {
    var ui = SpreadsheetApp.getUi();
    ensureMaster_();
    ensureLedger_();
    var plan = planImport_();
    if (!plan.oldSheet) {
      ui.alert('旧バージョンの「ALL」シートが見つかりませんでした。\n' +
        '別のファイルにある場合は、ALLタブを右クリック →［コピー先］でこのファイルにコピーしてから実行してください。');
      return;
    }
    var msg = '「' + plan.oldSheet.getName() + '」から ' + plan.rows.length + '人を「' + SH.ledger + '」に取り込みます。';
    if (plan.skipped) msg += '\n（すでに' + SH.ledger + 'にいる ' + plan.skipped + '人は飛ばします）';
    if (plan.missingHeads.length) msg += '\n※ 旧シートに見つからない列：' + plan.missingHeads.join('・');
    msg += '\n\n最終通院日・次回予定日などの列は新しい表にないため取り込みません（対象の○・クラウド区分は取り込みます）。' +
      '\n「' + plan.oldSheet.getName() + '」シートは変更せず、そのまま残します。\n\n実行しますか？';
    if (ui.alert('旧データの取り込み', msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
    var res = runImport_(plan);
    refreshAll_({ wait: 30000 });
    ui.alert('取り込み完了', res.message, ui.ButtonSet.OK);
  });
}

/** 旧ALLシートを読み、取り込む行を用意する（まだ書き込まない） */
function planImport_() {
  initTz_();
  var plan = { oldSheet: findOldSheet_(OLD_ALL_NAMES), rows: [], skipped: 0, missingHeads: [] };
  if (!plan.oldSheet) return plan;
  var data = plan.oldSheet.getDataRange().getValues();
  if (data.length < 2) return plan;
  var head = data[0].map(function (h) { return String(h).replace(/[\s　]/g, ''); });
  var idx = {};
  Object.keys(OLD_HEADERS).forEach(function (k) {
    idx[k] = -1;
    OLD_HEADERS[k].forEach(function (h) { if (idx[k] < 0) idx[k] = head.indexOf(h); });
  });
  if (idx.name < 0) throw new Error('「' + plan.oldSheet.getName() + '」に「名前」（または「氏名」）の列が見つかりません。');
  ['device', 'supplier', 'intro', 'exit'].forEach(function (k) { if (idx[k] < 0) plan.missingHeads.push(HEAD[k]); });

  var ledger = findSheet_('ledger');
  var c = ledgerCols_(ledger);
  requireCols_(c);
  var have = ledger.getLastRow() >= 2 ? ledger.getRange(2, 1, ledger.getLastRow() - 1, c.lastCol).getValues() : [];
  var ids = {};
  var keys = {};
  have.forEach(function (r) {
    var id = trim_(r[c.id - 1]);
    if (id) ids[id] = true;
    if (trim_(r[c.name - 1])) keys[nameKey_(r[c.name - 1]) + '|' + dateKey_(r[c.intro - 1])] = true;
  });

  var today = todayDn_();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var get = function (k) { return idx[k] >= 0 ? row[idx[k]] : ''; };
    var name = trim_(get('name'));
    if (!name) continue;
    var id = trim_(get('id'));
    var key = nameKey_(name) + '|' + dateKey_(get('intro'));
    if ((id && ids[id]) || keys[key]) { plan.skipped++; continue; }
    if (id) ids[id] = true;
    keys[key] = true;
    var oldStatus = trim_(get('status'));
    var note = trim_(get('note'));
    var rec = {
      id: id === '' ? '' : (/^\d+$/.test(id) ? Number(id) : id),
      name: name, device: trim_(get('device')), supplier: trim_(String(get('supplier')).split('|')[0]),
      cloud: trim_(get('cloud')),
      repStart: importDate_(get('repStart'), today), repEnd: importDate_(get('repEnd'), today),
      intro: importDate_(get('intro'), today), exit: importDate_(get('exit'), today),
      target: targetMark_(get('target')), note: note, status: '', reason: trim_(get('reason'))
    };
    var exitDn = dnOf_(rec.exit, today);
    if (exitDn !== null) rec.status = exitDn <= today ? STATUS_EXIT : STATUS_ACTIVE;
    else rec.status = /離脱|移管/.test(oldStatus) ? STATUS_EXIT : STATUS_ACTIVE;
    if (rec.status === STATUS_EXIT && !rec.reason) {
      rec.reason = (/移管/.test(oldStatus) || /移管/.test(note)) ? REASON_MOVED : REASON_UNKNOWN;
    }
    if (rec.status === STATUS_EXIT) rec.target = '';
    plan.rows.push(rec);
  }
  return plan;
}

function runImport_(plan) {
  if (!plan.oldSheet) return { message: '旧データ（ALL）が見つかりませんでした。' };
  var ledger = findSheet_('ledger');
  var c = ledgerCols_(ledger);
  requireCols_(c);
  var master = importOldMaster_(plan.rows);
  if (plan.rows.length) {
    var info = nextIdInfo_(columnValues_(ledger, c.id).concat(plan.rows.map(function (r) { return r.id; })));
    plan.rows.forEach(function (r) { if (r.id === '' && info.auto) r.id = info.next++; });
    var start = Math.max(ledger.getLastRow() + 1, 2);
    ensureSize_(ledger, start + plan.rows.length - 1, c.lastCol);
    LEDGER.forEach(function (col) {
      ledger.getRange(start, c[col.key], plan.rows.length, 1)
        .setValues(plan.rows.map(function (r) { return [r[col.key] === undefined ? '' : r[col.key]]; }));
    });
  }
  applyLedgerRules_();
  var msg = plan.rows.length + '人を取り込みました。';
  if (plan.skipped) msg += '（すでにいた ' + plan.skipped + '人は飛ばしました）';
  if (master.fromConfig) msg += '\n旧「設定」から料金などを ' + master.fromConfig + '件［マスタ］に反映しました。';
  if (master.added.length) msg += '\n［マスタ］にない組み合わせを追加しました：' + master.added.join('、') + '（確認してください）';
  return { message: msg };
}

/** 旧「設定」の料金マスタと、取り込んだ患者の機器・業者を［マスタ］に反映する（空欄だけ埋める） */
function importOldMaster_(rows) {
  var res = { fromConfig: 0, added: [] };
  var sh = findSheet_('master');
  if (!sh) return res;
  var head = rowText_(sh, 4);
  var cols = MASTER_HEAD.map(function (h) { return head.indexOf(h) + 1; });
  if (!cols[0] || !cols[1]) return res;
  var last = sh.getLastRow();
  var n = Math.max(last - 4, 0);
  var table = [];
  if (n) {
    var colVals = cols.map(function (col) {
      return col ? sh.getRange(5, col, n, 1).getValues().map(function (r) { return r[0]; }) : null;
    });
    for (var i = 0; i < n; i++) {
      var rec = {};
      MASTER_FIELDS.forEach(function (f, j) { rec[f] = colVals[j] ? colVals[j][i] : ''; });
      if (trim_(rec.device) || trim_(rec.supplier)) table.push(rec);
    }
  }
  var find = function (d, s) {
    for (var i2 = 0; i2 < table.length; i2++) {
      if (trim_(table[i2].device) === d && trim_(table[i2].supplier) === s) return table[i2];
    }
    return null;
  };
  var changed = false;
  var upsert = function (fields, note) {
    var cur = find(fields.device, fields.supplier);
    if (!cur) {
      cur = { device: fields.device, supplier: fields.supplier, maker: '', cloud: '', price: '', free: 'なし', note: note || '' };
      table.push(cur);
      changed = true;
      if (note) res.added.push(fields.device + '（' + fields.supplier + '）');
    }
    ['maker', 'cloud', 'price', 'free', 'note'].forEach(function (f) {
      if (fields[f] !== undefined && fields[f] !== '' && (cur[f] === '' || cur[f] === null)) {
        cur[f] = fields[f];
        changed = true;
      }
    });
    if (fields.free === 'あり' && cur.free === 'なし' && !note) { cur.free = 'あり'; changed = true; }
  };

  var cfg = findOldSheet_(OLD_CONFIG_NAMES);
  if (cfg) {
    var v = cfg.getDataRange().getValues();
    var kinds = {};
    for (var r = 0; r < v.length; r++) {
      var row = v[r].map(function (x) { return String(x).replace(/[\s　]/g, ''); });
      var kc = row.indexOf('既定のクラウド区分');
      var rc = row.indexOf('料金キー');
      if (kc < 1 && rc < 0) continue;
      for (var r2 = r + 1; r2 < v.length; r2++) {
        if (kc >= 1) {
          var kind = trim_(v[r2][kc - 1]);
          if (kind) kinds[kind] = { cloud: trim_(v[r2][kc]), maker: trim_(v[r2][kc + 1]) };
        }
      }
      if (rc >= 0) {
        for (var r3 = r + 1; r3 < v.length; r3++) {
          var sup = trim_(v[r3][rc + 1]);
          var dev = trim_(v[r3][rc + 2]);
          if (!sup || !dev) continue;
          var net = num_(v[r3][rc + 3]);
          var gross = num_(v[r3][rc + 4]);
          var price = gross !== null ? gross : (net !== null ? Math.round(net * 1.1) : '');
          var k = kinds[dev] || {};
          upsert({ device: dev, supplier: sup, maker: k.maker || '', cloud: k.cloud || '', price: price,
                   free: trim_(v[r3][rc + 6]) === 'あり' ? 'あり' : '', note: trim_(v[r3][rc + 8]) });
          res.fromConfig++;
        }
      }
      break;
    }
  }
  (rows || []).forEach(function (p) {
    if (p.device && p.supplier) upsert({ device: p.device, supplier: p.supplier }, '旧データから自動追加（確認してください）');
  });

  if (changed) {
    ensureSize_(sh, 5 + table.length, Math.max.apply(null, cols));
    cols.forEach(function (col, j) {
      if (!col) return;
      if (n) sh.getRange(5, col, n, 1).clearContent();
      if (table.length) {
        sh.getRange(5, col, table.length, 1).setValues(table.map(function (t) {
          var x = t[MASTER_FIELDS[j]];
          return [x === null || x === undefined ? '' : x];
        }));
      }
    });
  }
  return res;
}

function importDate_(v, today) {
  if (v instanceof Date || v === '' || v === null) return v === null ? '' : v;
  var dn = parseDateText_(v, today);
  return dn === null ? v : dnToCellDate_(dn);
}

/** 旧バージョンのシート（ALL・設定）を探す。「ALL のコピー」のようにコピーしてきたものも探す */
function findOldSheet_(names) {
  var ss = ss_();
  for (var i = 0; i < names.length; i++) {
    var exact = ss.getSheetByName(names[i]);
    if (exact && !ownedKey_(exact)) return exact;
  }
  var sheets = ss.getSheets();
  for (var j = 0; j < sheets.length; j++) {
    var n = sheets[j].getName();
    for (var k = 0; k < names.length; k++) {
      var b = names[k];
      if ((n.indexOf(b + ' のコピー') === 0 || n.indexOf(b + 'のコピー') === 0 || n === 'Copy of ' + b) &&
          !ownedKey_(sheets[j])) return sheets[j];
    }
  }
  return null;
}

function hideOldTabs() {
  withUi_(function () {
    var ui = SpreadsheetApp.getUi();
    var targets = ss_().getSheets().filter(function (sh) {
      if (sh.isSheetHidden() || ownedKey_(sh)) return false;
      var name = sh.getName();
      if (OLD_TABS.indexOf(name) >= 0 || /（旧\d*）$/.test(name) || /^(ALL|設定) ?のコピー/.test(name)) return true;
      return sh.getRange('A1').getFormula().indexOf('FILTER(ALL!') >= 0;   // 旧バージョンの機種別タブ
    });
    if (!targets.length) {
      ui.alert('非表示にする旧バージョンのタブはありませんでした。');
      return;
    }
    var names = targets.map(function (sh) { return sh.getName(); });
    var ok = ui.alert('旧バージョンのタブを非表示にする',
      names.join('、') + '\n\nを非表示にします（削除はしません）。\n' +
      '必要になったら、画面下のタブ一覧（≡）から表示に戻せます。\n\n実行しますか？', ui.ButtonSet.OK_CANCEL);
    if (ok !== ui.Button.OK) return;
    targets.forEach(function (sh) { sh.hideSheet(); });
    ui.alert(names.length + '個のタブを非表示にしました。');
  });
}


// ============================================================
// 外部連携用（旧バージョンと同じ形で返す）
// ============================================================
/** 患者の一覧を配列で返す（旧バージョンと同じ形）。target は対象に○が付いている人が 'TRUE'。 */
function getPatientsForBatch() {
  var ctx = loadContext_();
  var ds = function (dn) { return dn === null ? '' : fmtDn_(dn); };
  return ctx.patients.map(function (p) {
    var info = ctx.master.info[p.device];
    return {
      id: p.id, name: p.name, kind: p.device, supplier: p.supplier, cloud: p.cloud || (info ? info.cloud : ''),
      status: p.status,
      target: p.target ? 'TRUE' : 'FALSE',
      start_date: ds(p.repStart), end_date: ds(p.repEnd), intro_date: ds(p.intro), last_visit: '',
      exit_date: ds(p.exit), next_due: '', days_to_next: '', months_no_visit: '', other: p.note, reason: p.reason
    };
  });
}


// ============================================================
// シートの用意・書式の共通部品
// ============================================================
function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** 患者一覧を書き換えるときの順番待ち。取れなければ null（呼ぶ側で続けるか決める） */
function docLock_(ms) {
  try {
    var lock = LockService.getDocumentLock();
    return lock && lock.tryLock(ms) ? lock : null;
  } catch (e) {
    return null;
  }
}

function ownedKey_(sh) {
  var md = sh.getDeveloperMetadata();
  for (var i = 0; i < md.length; i++) {
    if (md[i].getKey() === APP_KEY) return md[i].getValue();
  }
  return '';
}

function markOwned_(sh, key) {
  if (ownedKey_(sh) !== key) sh.addDeveloperMetadata(APP_KEY, key);
}

/** 管理しているタブを返す。タブ名が変えられていても目印で探し、元の名前に戻す */
function findSheet_(key) {
  var ss = ss_();
  var sh = ss.getSheetByName(SH[key]);
  if (sh) return sh;
  var found = ss.createDeveloperMetadataFinder().withKey(APP_KEY).withValue(key).find();
  for (var i = 0; i < found.length; i++) {
    var loc = found[i].getLocation();
    if (loc.getLocationType() === SpreadsheetApp.DeveloperMetadataLocationType.SHEET) {
      var s = loc.getSheet();
      s.setName(SH[key]);
      return s;
    }
  }
  return null;
}

/** タブを用意する。同じ名前の別のシートがあれば（looksOk で引き継げないとき）「（旧）」を付けて残す */
function adoptOrCreate_(key, looksOk) {
  var sh = findSheet_(key);
  if (sh && ownedKey_(sh) !== key) {
    if (looksOk(sh)) {
      markOwned_(sh, key);
    } else {
      sh.setName(uniqueName_(SH[key] + '（旧）'));
      sh = null;
    }
  }
  if (!sh) {
    sh = ss_().insertSheet(SH[key]);
    markOwned_(sh, key);
  }
  return sh;
}

/** 自動で作るタブ（中身は毎回作り直す）。直接編集しないよう警告だけ出す保護を付ける */
function outputSheet_(key) {
  var sh = adoptOrCreate_(key, function () { return false; });
  var ps = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  var p = ps.length ? ps[0] : sh.protect().setDescription('CPAP管理：自動で作るタブ（書き込んでも次の更新で上書きされます）')
    .setWarningOnly(true);
  if (key === 'device') p.setUnprotectedRanges([sh.getRange(DEVICE_SEL)]);
  return sh;
}

function uniqueName_(base) {
  var name = base;
  for (var i = 2; ss_().getSheetByName(name); i++) name = base.replace(/（旧）$/, '（旧' + i + '）');
  return name;
}

/** 作り直す前に、グラフ・結合・入力規則・書式などをすべて消す */
function resetSheet_(sh) {
  sh.getCharts().forEach(function (ch) { sh.removeChart(ch); });
  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  var all = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  all.breakApart();
  all.clearDataValidations();
  all.clearNote();
  sh.clearConditionalFormatRules();
  sh.clear();
  sh.showColumns(1, sh.getMaxColumns());
  sh.setRowHeights(1, sh.getMaxRows(), 21);
}

function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

function rowText_(sh, row) {
  var last = sh.getLastColumn();
  if (last < 1 || sh.getMaxRows() < row) return [];
  return sh.getRange(row, 1, 1, last).getDisplayValues()[0].map(function (h) { return trim_(h); });
}

function columnValues_(sh, col) {
  var last = sh.getLastRow();
  if (last < 2 || !col) return [];
  return sh.getRange(2, col, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

/** 患者一覧の見出し → 列番号（完全一致。見つからなければ 0） */
function ledgerCols_(sh) {
  var head = rowText_(sh, 1);
  var c = { lastCol: Math.max(head.length, 1), missing: [] };
  LEDGER.forEach(function (col) {
    c[col.key] = head.indexOf(col.head) + 1;
    if (!c[col.key]) c.missing.push(col.head);
  });
  return c;
}

function requireCols_(c) {
  if (c.missing.length) {
    throw configError_('「' + SH.ledger + '」に「' + c.missing.join('」「') + '」の列が見つかりません。\n' +
      'メニュー［CPAP管理］→［管理・設定］→［初期セットアップ／修復］を実行すると、足りない列が右端に追加されます。');
  }
}

function title_(sh, text, sub) {
  sh.getRange('A1').setValue(text).setFontSize(15).setFontWeight('bold').setFontColor(C_TITLE);
  if (sub) sh.getRange('A2').setValue(sub).setFontSize(9).setFontColor(C_SUB);
  sh.setRowHeight(1, 30);
}

function headStyle_(range) {
  range.setFontWeight('bold').setBackground(C_HEAD).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}

/** 見出し＋本体の表。戻り値は表の次の行 */
function table_(sh, row, col, headers, rows, opt) {
  opt = opt || {};
  var w = headers.length;
  sh.getRange(row, col, 1, w).setValues([headers]);
  headStyle_(sh.getRange(row, col, 1, w));
  if (!rows.length) {
    sh.getRange(row + 1, col).setValue(opt.empty || '該当なし').setFontColor('#808080');
    return row + 2;
  }
  var body = sh.getRange(row + 1, col, rows.length, w);
  body.setValues(rows).setBorder(true, true, true, true, true, true, C_BORDER, SpreadsheetApp.BorderStyle.SOLID);
  (opt.formats || []).forEach(function (f, i) {
    if (f) sh.getRange(row + 1, col + i, rows.length, 1).setNumberFormat(f);
  });
  (opt.center || []).forEach(function (i) {
    sh.getRange(row + 1, col + i, rows.length, 1).setHorizontalAlignment('center');
  });
  if (opt.total) sh.getRange(row + rows.length, col, 1, w).setFontWeight('bold').setBackground(C_TOTAL);
  return row + 1 + rows.length;
}

/** 青い帯の見出しつきの表 */
function boxTable_(sh, row, col, title, headers, rows, opt) {
  sh.getRange(row, col, 1, headers.length).setBackground(C_SECTION);
  sh.getRange(row, col).setValue(title).setFontWeight('bold').setFontColor('#ffffff');
  return table_(sh, row + 1, col, headers, rows, opt);
}

/** 大きな数字のカード（3行：見出し・数字・補足） */
function cards_(sh, row, cards) {
  cards.forEach(function (cd) {
    var top = sh.getRange(row, cd.col, 1, cd.span);
    var mid = sh.getRange(row + 1, cd.col, 1, cd.span);
    var bot = sh.getRange(row + 2, cd.col, 1, cd.span);
    if (cd.span > 1) {
      top.merge();
      mid.merge();
      bot.merge();
    }
    top.setValue(cd.label).setBackground(C_HEAD).setFontColor('#ffffff').setFontWeight('bold')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    mid.setValue(cd.value).setNumberFormat(cd.format || '#,##0"人"').setFontSize(20).setFontWeight('bold')
      .setFontColor(C_TITLE).setBackground(C_CARD).setHorizontalAlignment('center').setVerticalAlignment('middle');
    bot.setValue(cd.sub || '').setFontSize(9).setFontColor(C_SUB).setBackground(C_CARD)
      .setHorizontalAlignment('center').setVerticalAlignment('top');
  });
  sh.setRowHeight(row, 24);
  sh.setRowHeight(row + 1, 42);
  sh.setRowHeight(row + 2, 20);
}

/** グラフ（type：'column'／'line'／'pie'） */
function chart_(sh, type, range, opt) {
  var b = sh.newChart();
  b = type === 'line' ? b.asLineChart() : (type === 'pie' ? b.asPieChart() : b.asColumnChart());
  b.addRange(range)
    .setNumHeaders(1)
    .setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH)
    .setPosition(opt.row, opt.col, 0, 0)
    .setOption('title', opt.title)
    .setOption('width', opt.width)
    .setOption('height', opt.height)
    .setOption('legend', { position: opt.legend || (type === 'pie' ? 'right' : 'bottom') });
  if (opt.colors) b.setOption('colors', opt.colors);
  if (opt.reverse) b.reverseCategories();
  if (type === 'pie') b.setOption('pieSliceText', 'value');
  sh.insertChart(b.build());
}


// ============================================================
// 文字・数値・日付の共通部品
//   日付は内部では「1970/1/1 からの日数」（整数）で扱います。
//   スプレッドシートとスクリプトのタイムゾーンが違っても日付がずれないようにするためです。
// ============================================================
var MS_DAY = 86400000;
var TZ = null;
var SAME_TZ = true;

function initTz_() {
  if (TZ) return;
  TZ = ss_().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  SAME_TZ = TZ === Session.getScriptTimeZone();
}

function trim_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/^[\s　]+|[\s　]+$/g, '');
}

/** 対象の欄の値を「○」か空欄にそろえる（×・x・0・FALSE・なし などは空欄） */
function targetMark_(v) {
  if (v === true) return TARGET_MARK;
  if (v === false || v === null || v === undefined) return '';
  var s = toHalfWidth_(trim_(v));
  if (!s || /^(x|×|✕|✖|-|ー|−|0|false|no|なし|無|いいえ)$/i.test(s)) return '';
  return TARGET_MARK;
}

function nameKey_(v) {
  return trim_(v).replace(/[\s　]/g, '');
}

function comboKey_(device, supplier) {
  return device + '\u0001' + supplier;
}

function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = toHalfWidth_(trim_(v)).replace(/[,円¥\s]/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function toHalfWidth_(s) {
  return String(s).replace(/[！-～]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  }).replace(/　/g, ' ');
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function zeros_(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(0);
  return a;
}

/** 折り返したときのおおよその行数（全角は2、半角は1と数える） */
function textLines_(s, unitsPerLine) {
  var units = 0;
  for (var i = 0; i < s.length; i++) units += s.charCodeAt(i) > 0xFF ? 2 : 1;
  return Math.max(1, Math.ceil(units / unitsPerLine));
}

function a1col_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

function compareId_(a, b) {
  var x = a.idText;
  var y = b.idText;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
  return x < y ? -1 : (x > y ? 1 : 0);
}

function dn_(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
}

function ymd_(dn) {
  var x = new Date(dn * MS_DAY);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

function validDn_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var dn = dn_(y, m, d);
  var t = ymd_(dn);
  return t.y === y && t.m === m && t.d === d ? dn : null;
}

function addMonthsDn_(dn, k) {
  var t = ymd_(dn);
  var total = t.y * 12 + (t.m - 1) + k;
  var y = Math.floor(total / 12);
  var m = total - y * 12 + 1;
  var lastDay = ymd_(dn_(y, m + 1, 1) - 1).d;
  return dn_(y, m, Math.min(t.d, lastDay));
}

/** 月曜はじまりの週の初日 */
function weekStartDn_(dn) {
  return dn - (((dn + 3) % 7) + 7) % 7;
}

/** a から b までに、まるまる何ヶ月たったか */
function monthsBetween_(a, b) {
  if (a === null || b === null || b < a) return null;
  var x = ymd_(a);
  var y = ymd_(b);
  return Math.max((y.y - x.y) * 12 + (y.m - x.m) - (y.d < x.d ? 1 : 0), 0);
}

function durationText_(months) {
  if (months === null || months === undefined || months === '') return '';
  if (months < 1) return '1ヶ月未満';
  if (months < 12) return months + 'ヶ月';
  var y = Math.floor(months / 12);
  var m = months % 12;
  return y + '年' + (m ? m + 'ヶ月' : '');
}

function fmtDn_(dn) {
  var t = ymd_(dn);
  return t.y + '/' + pad2_(t.m) + '/' + pad2_(t.d);
}

function fmtMd_(dn) {
  var t = ymd_(dn);
  return pad2_(t.m) + '/' + pad2_(t.d);
}

function isoDn_(dn) {
  var t = ymd_(dn);
  return t.y + '-' + pad2_(t.m) + '-' + pad2_(t.d);
}

function isoToDn_(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trim_(s));
  return m ? validDn_(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** 重複チェック用：日付（Date でも文字でも）を同じ形の文字にそろえる */
function dateKey_(v) {
  var dn = dnOf_(v, todayDn_());
  return dn === null ? trim_(v) : String(dn);
}

/** セルの日付（Date）→ 日数。スプレッドシートのタイムゾーンでの日付を使う */
function cellDn_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  initTz_();
  if (SAME_TZ) return dn_(d.getFullYear(), d.getMonth() + 1, d.getDate());
  var p = Utilities.formatDate(d, TZ, 'yyyy-M-d').split('-');
  return dn_(Number(p[0]), Number(p[1]), Number(p[2]));
}

/** 日数 → セルに書き込む Date（スプレッドシートで見てその日付になるもの） */
function dnToCellDate_(dn) {
  initTz_();
  var t = ymd_(dn);
  if (SAME_TZ) return new Date(t.y, t.m - 1, t.d);
  return Utilities.parseDate(t.y + '-' + t.m + '-' + t.d, TZ, 'yyyy-M-d');
}

function todayDn_() {
  return cellDn_(new Date());
}

/** セルの値（Date・文字・数値）→ 日数。空や読めないときは null */
function dnOf_(v, today) {
  if (v instanceof Date) return cellDn_(v);
  if (v === '' || v === null || v === undefined) return null;
  return parseDateText_(v, today);
}

/**
 * 文字で入った日付を読む。
 *   t／今日、y／昨日、2026/10/1・2026-10-01・2026.10.1・2026年10月1日、20261001、
 *   R8.10.1・令和8年10月1日・H31.4.30、10/1（今年）、全角数字も可
 */
function parseDateText_(v, today) {
  var s = toHalfWidth_(String(v)).replace(/^\s+|\s+$/g, '');
  if (!s) return null;
  if (/^(t|today|今日|きょう)$/i.test(s)) return today;
  if (/^(y|yesterday|昨日|きのう)$/i.test(s)) return today - 1;
  var m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return validDn_(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?$/.exec(s);
  if (m) return validDn_(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(R|令和|H|平成)\s*(\d{1,2}|元)\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?$/i.exec(s);
  if (m) {
    var n = m[2] === '元' ? 1 : Number(m[2]);
    var base = /^(R|令和)$/i.test(m[1]) ? 2018 : 1988;
    return validDn_(base + n, Number(m[3]), Number(m[4]));
  }
  m = /^(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?$/.exec(s);
  if (m) return validDn_(ymd_(today).y, Number(m[1]), Number(m[2]));
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    var serial = Math.floor(Number(s));   // スプレッドシートのシリアル値（1899/12/30 起点）
    if (serial > 20000 && serial < 80000) return serial - 25569;
  }
  return null;
}
