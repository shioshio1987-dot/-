'use strict';
/**
 * サイドバー（SidebarForm.html）をブラウザで動かして確かめる。
 * google.script.run は、このプロセスの中のモック（Code.gs）を呼ぶ代わりのものに差し替える。
 *   TZ=Asia/Tokyo node test/sidebar-test.js [スクリーンショットの保存先フォルダ]
 */
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const { load } = require('./harness');

const shotDir = process.argv[2] || null;

(async () => {
  const t = load({});
  const gs = t.gs;
  gs.setup();
  t.typeIn('患者一覧', 'B2', '既存 太郎');
  t.typeIn('患者一覧', 'C2', 'SBOX');
  t.typeIn('患者一覧', 'G2', '2026/9/2');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 300, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('callServer', (name, argsJson) => {
    try {
      const value = gs[name](...JSON.parse(argsJson));
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  });
  await page.addInitScript(() => {
    function runner(ok, ng) {
      return new Proxy({}, {
        get(_, name) {
          if (name === 'withSuccessHandler') return fn => runner(fn, ng);
          if (name === 'withFailureHandler') return fn => runner(ok, fn);
          return (...args) => {
            window.callServer(name, JSON.stringify(args)).then(r => {
              const res = JSON.parse(r);
              if (res.ok) { if (ok) ok(res.value); } else if (ng) ng({ message: res.error });
            });
          };
        }
      });
    }
    window.google = { script: { run: runner(null, null) } };
  });

  const open = async panel => {
    gs[panel === 'report' ? 'openReportForm' : 'openRegisterForm']();
    const html = t.state.sidebars[t.state.sidebars.length - 1]._html;
    // 初期化スクリプト（google.script.run の代わり）を効かせるため、URL を開く形で読み込む
    await page.route('http://sidebar.test/', route => route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }));
    await page.goto('http://sidebar.test/');
    await page.waitForFunction(() => document.getElementById('f-device').options.length > 1);
  };
  let pass = 0;
  const step = async (name, fn) => { await fn(); pass++; };

  await open('register');
  await step('初期表示：IDのヒント・導入日＝今日・機器の候補', async () => {
    assert.strictEqual(await page.inputValue('#f-intro'), '2026-10-01');
    assert.strictEqual(await page.textContent('#id-hint'), '空欄なら 2 になります');
    const opts = await page.$$eval('#f-device option', os => os.map(o => o.value));
    assert.ok(opts.includes('AirSense10') && opts.includes('SBOX（加湿器付）'));
  });
  await step('機器を選ぶと業者がしぼられ、1社なら自動で選ばれる', async () => {
    await page.selectOption('#f-device', 'SleepStyle Auto Rx');
    assert.strictEqual(await page.inputValue('#f-supplier'), 'チェスト');
    await page.selectOption('#f-device', 'AirSense10');
    const sups = await page.$$eval('#f-supplier option', os => os.map(o => o.value));
    assert.deepStrictEqual(sups, ['', 'フクダライフテック', 'RISEF']);
    assert.strictEqual(await page.inputValue('#f-supplier'), '');
  });
  await step('登録すると患者一覧に入り、フォームが空になる', async () => {
    await page.fill('#f-name', '新規 花子');
    await page.selectOption('#f-supplier', 'RISEF');
    await page.fill('#f-intro', '2026-09-20');
    await page.fill('#f-note', 'サイドバーから');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'sidebar-register.png'), fullPage: true });
    await page.click('#reg-btn');
    await page.waitForSelector('#reg-msg.ok');
    assert.ok((await page.textContent('#reg-msg')).includes('3行目に登録しました'));
    assert.strictEqual(await page.inputValue('#f-name'), '');
    assert.strictEqual(await page.inputValue('#f-device'), '', '機器も選び直してもらう');
    assert.strictEqual(await page.inputValue('#f-supplier'), '');
    assert.strictEqual(await page.textContent('#id-hint'), '空欄なら 3 になります');
    const row = t.values('患者一覧', 'A3:L3')[0];
    assert.deepStrictEqual([row[0], row[1], row[2], row[3], row[6], t.ymdOf(row[7]), row[9], row[10]],
      [2, '新規 花子', 'AirSense10', 'RISEF', '○', '2026/09/20', 'サイドバーから', '利用中'], '対象は最初から○');
  });
  await step('同じ名前なら確認が出て、「登録する」で登録できる', async () => {
    await page.fill('#f-name', '既存 太郎');
    await page.selectOption('#f-device', 'SBOX');
    await page.click('#reg-btn');
    await page.waitForSelector('#reg-msg.ask');
    assert.ok((await page.textContent('#reg-msg')).includes('すでに登録があります'));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'sidebar-dup.png'), fullPage: true });
    await page.click('#reg-msg button.primary');
    await page.waitForSelector('#reg-msg.ok');
    assert.strictEqual(t.values('患者一覧', 'B4')[0][0], '既存 太郎');
  });
  await step('「レポート対象（○）にする」を外して登録すると○なし', async () => {
    assert.strictEqual(await page.isChecked('#f-target'), true, '登録のたびにチェックは戻る');
    await page.fill('#f-name', '対象外 三郎');
    await page.selectOption('#f-device', 'SBOX');
    await page.uncheck('#f-target');
    await page.click('#reg-btn');
    await page.waitForSelector('#reg-msg.ok');
    assert.deepStrictEqual([t.values('患者一覧', 'B5')[0][0], t.values('患者一覧', 'G5')[0][0]], ['対象外 三郎', '']);
    assert.strictEqual(await page.isChecked('#f-target'), true);
  });
  await step('業者が複数ある機器に変えると、前の業者は引き継がない', async () => {
    await page.selectOption('#f-device', 'SBOX');
    assert.strictEqual(await page.inputValue('#f-supplier'), 'RISEF');
    await page.selectOption('#f-device', 'AirSense10');
    assert.strictEqual(await page.inputValue('#f-supplier'), '');
  });
  await step('入力が足りないときは、ブラウザが送信を止めてその欄を知らせる', async () => {
    const before = t.sheet('患者一覧').getLastRow();
    await page.fill('#f-name', '途中 次郎');
    await page.selectOption('#f-device', 'AirSense10');
    await page.click('#reg-btn');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.$eval('#f-supplier', el => el.validity.valueMissing), true);
    assert.strictEqual(t.sheet('患者一覧').getLastRow(), before, '登録されていない');
  });
  await step('サーバー側のチェックのエラーも表示する（未来すぎる日付ではなく、期間の片方だけ）', async () => {
    await page.selectOption('#f-supplier', 'RISEF');
    await page.fill('#f-repStart', '2026-09-01');
    await page.click('#reg-btn');
    await page.waitForSelector('#reg-msg.err');
    assert.ok((await page.textContent('#reg-msg')).includes('開始日と終了日の両方'));
    await page.fill('#f-repStart', '');
    await page.fill('#f-name', '');
  });

  await open('report');
  await step('レポート期間タブ：先月の期間が表示される', async () => {
    assert.ok(await page.isVisible('#report'));
    assert.strictEqual(await page.textContent('#lm-text'), '2026/09/01 〜 2026/09/30');
    assert.strictEqual(await page.textContent('#tm-text'), '今日が1日のため使えません');
    assert.strictEqual(await page.inputValue('#cont-end'), '2026-09-30');
  });
  await step('選んだ行を確認 → 先月を入れる', async () => {
    t.select('患者一覧', ['A2:A4']);
    await page.click('#sel-btn');
    await page.waitForSelector('#sel-msg.info');
    assert.ok((await page.textContent('#sel-msg')).startsWith('選択中：3人'), await page.textContent('#sel-msg'));
    await page.click('#apply-btn');
    await page.waitForSelector('#rep-msg.ok');
    assert.ok((await page.textContent('#rep-msg')).includes('3人（対象に○も付けました）'));
    assert.deepStrictEqual(t.display('患者一覧', 'E2:G4'), [
      ['2026/09/01', '2026/09/30', '○'], ['2026/09/01', '2026/09/30', '○'], ['2026/09/01', '2026/09/30', '○']]);
  });
  await step('日付欄に触るとその選択肢が選ばれる／前後が逆ならエラー', async () => {
    await page.fill('#fix-start', '2026-09-30');
    await page.fill('#fix-end', '2026-09-01');
    assert.ok(await page.isChecked('input[value=fixed]'));
    await page.click('#apply-btn');
    await page.waitForSelector('#rep-msg.err');
    assert.ok((await page.textContent('#rep-msg')).includes('終了日が開始日より前'));
  });
  await step('消すときは確認してから消す', async () => {
    await page.click('#clear-btn');
    await page.waitForSelector('#rep-msg.ask');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'sidebar-report.png'), fullPage: true });
    await page.click('#rep-msg button.primary');
    await page.waitForSelector('#rep-msg.ok');
    assert.deepStrictEqual(t.display('患者一覧', 'E2:F2'), [['', '']]);
  });
  await step('対象（○）だけを外す・付ける・すべて消す', async () => {
    t.select('患者一覧', ['A3:A4']);
    await page.click('#mark-off-btn');
    await page.waitForSelector('#mark-msg.ok');
    assert.deepStrictEqual(t.values('患者一覧', 'G2:G4'), [['○'], [''], ['']]);
    await page.click('#mark-on-btn');
    await page.waitForFunction(() => document.getElementById('mark-msg').textContent.includes('付けました'));
    assert.deepStrictEqual(t.values('患者一覧', 'G2:G4'), [['○'], ['○'], ['○']]);
    await page.click('#mark-clear-btn');
    await page.waitForSelector('#mark-msg.ask');
    assert.ok((await page.textContent('#mark-msg')).includes('いま 3人に○'));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'sidebar-marks.png'), fullPage: true });
    await page.click('#mark-msg button.primary');
    await page.waitForSelector('#mark-msg.ok');
    assert.deepStrictEqual(t.values('患者一覧', 'G2:G5'), [[''], [''], [''], ['']]);
  });
  await step('別のタブを選んでいるときは案内を出す', async () => {
    t.select('ダッシュボード', ['A1']);
    await page.click('#sel-btn');
    await page.waitForSelector('#sel-msg.err');
    assert.ok((await page.textContent('#sel-msg')).includes('「患者一覧」タブで'));
  });
  await step('集計を今すぐ更新', async () => {
    await page.click('#refresh-btn');
    await page.waitForSelector('#refresh-msg.ok');
    assert.ok((await page.textContent('#refresh-msg')).includes('集計を更新しました（4人）'));
  });
  await step('ページのエラーがない', async () => {
    assert.deepStrictEqual(errors, []);
  });

  await browser.close();
  console.log(`[sidebar] ${pass} 件OK`);
})().catch(e => {
  console.error('[sidebar] 失敗：', e && e.stack || e);
  process.exit(1);
});
