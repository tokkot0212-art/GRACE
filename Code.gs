/**
 * 美容室GRACE 予約システム（Google Apps Script）
 *
 * 予約台帳になるGoogleスプレッドシートの「拡張機能 → Apps Script」に
 * このファイルの中身をまるごと貼り付けて使います。手順は README.md を参照。
 *
 * ・予約サイトから空き状況の問い合わせ（GET）と予約（POST）を受け付けます
 * ・同じ時間に2人が同時に予約しても、先に届いた1件だけが入ります
 * ・新しい予約が入るとお店にメールが届き、メールアドレスを入れたお客様には確認メールが届きます
 *
 * 【お店のかんたん操作】（スプレッドシート「予約」シートで）
 * ・予約を取り消す … その行の「状態」を「キャンセル」にする（枠が空きます）
 * ・時間をふさぐ   … 新しい行に「予約日」「開始」「終了」を書き、お名前に「休み」などと書く
 * ・終日お休み     … 新しい行に「予約日」だけ書き、開始・終了は空欄にする
 */

const SETTINGS = {
  SHOP_NAME: '美容室GRACE',
  SHOP_TEL: '022-778-2454',
  SHOP_ADDRESS: '宮城県富谷市成田1丁目4-105',
  OPEN: '09:00',            // 開店時間（予約を受ける最初の時間）
  CLOSE: '18:00',           // 閉店時間（施術がこの時間までに終わる枠だけ受け付け）
  CLOSED_WEEKDAYS: [1],     // 定休日 0=日 1=月 2=火 3=水 4=木 5=金 6=土
  BUFFER_MIN: 15,           // 前のお客様との間にとる準備時間（分）
  SAME_DAY_CUTOFF_MIN: 60,  // 当日予約は今から何分後以降の枠だけ受け付けるか
  DAYS_AHEAD: 30,           // 何日先まで予約できるか
  NOTIFY_EMAIL: '',         // 予約通知の送り先。空欄ならこのスクリプトを作った人のGmail
};

const SHEET_NAME = '予約';
const TZ = 'Asia/Tokyo';
const HEAD = ['受付日時', '予約日', '開始', '終了', '所要(分)', 'メニュー', 'お名前', '電話', 'メール', 'ご来店', 'ご要望', '状態', '予約番号'];
const COL = { DATE: 1, START: 2, END: 3, MIN: 4, STATUS: 11 }; // 0始まり

/** 最初に1回だけ実行：予約シートを準備します */
function setup() {
  sheet_();
  Logger.log('準備できました。「デプロイ → 新しいデプロイ → ウェブアプリ」で公開してください。');
}

/* ---------------- 受付窓口 ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'availability') {
    const from = isDate_(p.from) ? p.from : today_();
    const to = isDate_(p.to) ? p.to : addDays_(from, SETTINGS.DAYS_AHEAD);
    return json_({ ok: true, booked: booked_(from, to), settings: publicSettings_() });
  }
  return json_({ ok: true, service: SETTINGS.SHOP_NAME + ' booking API' });
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: '送信内容を読み取れませんでした。' });
  }
  const msg = validate_(d);
  if (msg) return json_({ ok: false, error: 'invalid', message: msg });

  const s = toMin_(d.start), m = Math.round(Number(d.minutes)), en = s + m;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return json_({ ok: false, error: 'busy', message: '混み合っています。少し待ってからもう一度お試しください。' });
  }
  let id;
  try {
    const list = booked_(d.date, d.date)[d.date] || [];
    if (overlaps_(list, s, en)) {
      return json_({ ok: false, error: 'taken', message: 'その時間はすでにご予約が入っています。' });
    }
    id = newId_();
    sheet_().appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'),
      d.date, hm_(s), hm_(en), m,
      clean_(d.menu, 100), clean_(d.name, 50), clean_(d.tel, 20), clean_(d.email, 100),
      clean_(d.first, 10), clean_(d.note, 500), '予約', id,
    ]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  try { notify_(id, d, s, en); } catch (err) { console.error(err); }
  return json_({ ok: true, id: id });
}

/* ---------------- 空き状況 ---------------- */

function booked_(from, to) {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  const out = {};
  if (n < 1) return out;
  sh.getRange(2, 1, n, HEAD.length).getValues().forEach(function (r) {
    if (String(r[COL.STATUS]).trim() === 'キャンセル') return;
    const day = toDate_(r[COL.DATE]);
    if (!day || day < from || day > to) return;
    let s = toMin_(r[COL.START]), e = toMin_(r[COL.END]);
    if (s == null) { s = 0; e = 1440; }                          // 開始が空欄 → 終日お休み
    else if (e == null) { e = s + (Number(r[COL.MIN]) || 60); } // 終了が空欄 → 所要時間から計算
    (out[day] = out[day] || []).push([s, e]);                    // 時間だけ返す（お名前などは外に出さない）
  });
  return out;
}

function overlaps_(list, s, e) {
  const b = SETTINGS.BUFFER_MIN;
  return list.some(function (x) { return s < x[1] + b && x[0] < e + b; });
}

function publicSettings_() {
  return {
    open: SETTINGS.OPEN, close: SETTINGS.CLOSE, closedWeekdays: SETTINGS.CLOSED_WEEKDAYS,
    bufferMin: SETTINGS.BUFFER_MIN, sameDayCutoffMin: SETTINGS.SAME_DAY_CUTOFF_MIN, daysAhead: SETTINGS.DAYS_AHEAD,
  };
}

/* ---------------- 入力チェック ---------------- */

function validate_(d) {
  if (!d || d.action !== 'book') return '送信内容が正しくありません。';
  if (!isDate_(d.date)) return '日付が正しくありません。';
  const today = today_();
  if (d.date < today || d.date > addDays_(today, SETTINGS.DAYS_AHEAD)) return '予約できない日付です。';
  if (SETTINGS.CLOSED_WEEKDAYS.indexOf(weekday_(d.date)) >= 0) return 'その日は定休日です。';
  const s = toMin_(d.start), m = Math.round(Number(d.minutes));
  if (s == null || !(m >= 15 && m <= 480)) return '時間が正しくありません。';
  if (s < toMin_(SETTINGS.OPEN) || s + m > toMin_(SETTINGS.CLOSE)) return '営業時間外です。';
  if (d.date === today) {
    const now = toMin_(Utilities.formatDate(new Date(), TZ, 'HH:mm'));
    if (s < now + SETTINGS.SAME_DAY_CUTOFF_MIN) return '本日のその時間はネット予約を締め切りました。お電話でご相談ください。';
  }
  if (!String(d.name || '').trim()) return 'お名前を入力してください。';
  if (String(d.tel || '').replace(/\D/g, '').length < 10) return '電話番号を確認してください。';
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email))) return 'メールアドレスを確認してください。';
  return '';
}

/* ---------------- お知らせメール ---------------- */

function notify_(id, d, s, e) {
  const when = jpDate_(d.date) + ' ' + hm_(s) + '〜' + hm_(e);
  const owner = SETTINGS.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  const detail = [
    '予約番号：' + id,
    '日時　　：' + when,
    'メニュー：' + d.menu,
    'お名前　：' + d.name + ' 様',
    '電話　　：' + d.tel,
    'メール　：' + (d.email || '-'),
    'ご来店　：' + (d.first || '-'),
    'ご要望　：' + (d.note || 'なし'),
  ].join('\n');
  if (owner) {
    MailApp.sendEmail({
      to: owner,
      subject: '【' + SETTINGS.SHOP_NAME + '】新しいご予約 ' + when + ' ' + d.name + '様',
      body: 'ネット予約が入りました。\n\n' + detail + '\n\n予約台帳：' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    });
  }
  if (d.email) {
    MailApp.sendEmail({
      to: d.email,
      name: SETTINGS.SHOP_NAME,
      replyTo: owner || undefined,
      subject: '【' + SETTINGS.SHOP_NAME + '】ご予約ありがとうございます（' + when + '）',
      body: d.name + ' 様\n\nこのたびはご予約ありがとうございます。\n以下の内容で承りました。\n\n'
        + detail + '\n\n'
        + '当日は完全個室でお待ちしております。ほかのお客様はいらっしゃいませんので、どうぞゆっくりお過ごしください。\n'
        + '変更・キャンセルはお電話でご連絡ください。\n\n'
        + SETTINGS.SHOP_NAME + '\n' + SETTINGS.SHOP_ADDRESS + '\nTEL ' + SETTINGS.SHOP_TEL,
    });
  }
}

/* ---------------- 小さな道具 ---------------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange('B:D').setNumberFormat('@');   // 日付・時刻を文字のまま保存
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#f3e3de');
    sh.setFrozenRows(1);
    sh.getRange('L2:L').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['予約', '来店済', 'キャンセル', '休み'], true).setAllowInvalid(true).build());
    sh.setColumnWidth(6, 180); sh.setColumnWidth(11, 220);
  }
  return sh;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function isDate_(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function addDays_(ymd, n) {
  const d = new Date(ymd + 'T12:00:00+09:00');
  d.setTime(d.getTime() + n * 86400000);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function weekday_(ymd) { return Number(Utilities.formatDate(new Date(ymd + 'T12:00:00+09:00'), TZ, 'u')) % 7; }
function jpDate_(ymd) {
  const w = '日月火水木金土'.charAt(weekday_(ymd)), p = ymd.split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日(' + w + ')';
}
function toDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
}
function toMin_(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
  if (typeof v === 'number') return v < 1 ? Math.round(v * 1440) : null;
  const m = String(v).match(/(\d{1,2})\s*[:：時]\s*(\d{2})?/);
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
}
function hm_(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function clean_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;          // 数式として動かないように
  return s;
}
function newId_() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += c.charAt(Math.floor(Math.random() * c.length));
  return 'G' + Utilities.formatDate(new Date(), TZ, 'MMdd') + '-' + r;
}
