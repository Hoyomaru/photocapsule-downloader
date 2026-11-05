// ==UserScript==
// @name         写真カプセル＋ 順次ダウンローダー
// @namespace    local.photocapsule.sequential
// @version      2.4.2
// @description  合言葉の受信時、サイト標準の一斉保存をやめ、選んだフォルダ（またはダウンロードフォルダ）へ少数ずつ順番に保存する。URLの期限切れは自動で取り直し、中断しても続きから再開できる。コピーした合言葉をボタン1つで受け取れる
// @author       Hoyomaru
// @license      MIT
// @homepageURL  https://github.com/Hoyomaru/photocapsule-downloader
// @supportURL   https://github.com/Hoyomaru/photocapsule-downloader/issues
// @downloadURL  https://raw.githubusercontent.com/Hoyomaru/photocapsule-downloader/main/photocapsule-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/Hoyomaru/photocapsule-downloader/main/photocapsule-downloader.user.js
// @match        https://webapp.photo-capsule-puls.net/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        unsafeWindow
// @connect      r2.cloudflarestorage.com
// ==/UserScript==

/*
 * サイトの受信の流れ（2026-11 時点で確認）
 *   1. /v1/watchwords/search.json      合言葉 → 合言葉ID。結果は sessionStorage.searchResult に入る
 *   2. /v1/watchwords/download.json    合言葉ID → ファイル一覧（content_url = R2 の署名付きURL, contentSize, content_type）
 *   3. /v1/watchwords/downloadcomplete.json
 *   4. 全URLを fetch で同時に取得 → blob → a.click() で保存。3秒後に完了画面へ移動
 *
 * このスクリプトは 2 の応答を読み取り、4 の fetch は保留にして止める。
 * 各ファイルは次のどちらかで保存する（パネルで切り替え）
 *   フォルダ:     自分で fetch し、File System Access API で選んだフォルダへ書き込む。
 *                 ブラウザのダウンロード機能を使わないので、ファイル名が他の拡張機能に変えられない
 *   ダウンロード: GM_download でダウンロードフォルダ/写真カプセル/ に保存する。書き込み許可の確認が出ない
 * URL の期限が近づいたら 2 を自分で呼び直して新しい URL を得る（無料の合言葉のみ）。
 */

(function () {
  'use strict';

  // ===== 設定 =====
  const CFG = {
    defaultConcurrency: 3,
    maxConcurrency: 6,
    retries: 3,                      // 1ファイルあたりの再試行回数
    urlMarginMs: 60 * 1000,          // 期限の1分前になったら取り直す
    fallbackLifetimeMs: 600 * 1000,  // URLから期限を読めないときの想定(600秒)
    maxRefresh: 50,                  // 1回のジョブで取り直す上限
    fallbackSettleMs: 2000,
    downloadRoot: '写真カプセル',    // ダウンロード方式の保存先(ダウンロードフォルダの中)
  };
  const API = 'https://api.photo-capsule-puls.net';
  const DL_LIST_RE = /\/v1\/watchwords\/download\.json/;
  const SEARCH_RE = /\/v1\/watchwords\/search\.json/;
  const LOGIN_RE = /\/v1\/users\/servicelogin\.json/;
  const PENDING_KEY = 'pcseq:pendingWatchword'; // トップページへ移ってから入れる合言葉
  const WATCHWORD_MAX = 40;                      // サイトの入力欄の上限
  const STORE_PREFIX = 'job:';

  const W = unsafeWindow;
  const origFetch = W.fetch.bind(W);
  const isR2 = (u) => /\.r2\.cloudflarestorage\.com\//.test(u);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const urlKey = (u) => { try { return new URL(u).pathname; } catch (e) { return String(u); } };
  const baseName = (f) => String(f).split('/').pop();

  let userCode = '';
  let searchSentAt = 0;
  let job = null;
  let strayR2 = [];
  let fallbackTimer = null;
  let ui = null;

  // ===== サイトの通信を見張る =====

  // axios は XHR を使う。ユーザーコードとファイル一覧をここで受け取る
  (function hookXHR() {
    const P = W.XMLHttpRequest.prototype;
    const open = P.open;
    const setHeader = P.setRequestHeader;
    const send = P.send;
    P.open = function (method, url) {
      this.__pcUrl = String(url);
      return open.apply(this, arguments);
    };
    P.setRequestHeader = function (k, v) {
      if (/^x-photocapsule-usercode$/i.test(k) && v) userCode = String(v);
      return setHeader.apply(this, arguments);
    };
    P.send = function () {
      const url = this.__pcUrl || '';
      if (SEARCH_RE.test(url)) {
        searchSentAt = Date.now();
        this.addEventListener('load', () => {
          try {
            const json = this.response && typeof this.response === 'object' ? this.response : JSON.parse(this.responseText);
            onSearchResponse(json);
          } catch (e) { console.warn('[pcseq]', e); }
        });
      }
      if (DL_LIST_RE.test(url) || LOGIN_RE.test(url)) {
        this.addEventListener('load', () => {
          try {
            const json = this.response && typeof this.response === 'object' ? this.response : JSON.parse(this.responseText);
            onApiResponse(url, json);
          } catch (e) { console.warn('[pcseq]', e); }
        });
      }
      return send.apply(this, arguments);
    };
  })();

  // サイトの一斉取得(R2 への fetch)は保留にして止める。スクリプト自身の取得は origFetch を使う
  W.fetch = function (input, init) {
    const url = input instanceof W.Request ? input.url : String(input || '');
    if (isR2(url)) {
      strayR2.push(url);
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(startFromStrayUrls, CFG.fallbackSettleMs);
      return new Promise(() => {});
    }
    return origFetch(input, init);
  };

  function onApiResponse(url, json) {
    const data = json && json.data;
    if (!data) return;
    if (LOGIN_RE.test(url)) {
      const c = data.User && data.User.user_code;
      if (c) userCode = String(c);
      return;
    }
    const list = data.ContentsDownloadDetail;
    if (!Array.isArray(list) || !list.length) return;
    const id = new URL(url, location.href).searchParams.get('watchword_id');
    const meta = readSearchResult();
    const name = meta && String(meta.id) === String(id) ? meta.name : '';
    beginJob({
      id: String(id),
      name: safeName(name) || 'watchword_' + id,
      coin: isCoin(data.ContentsDownload, meta),
      files: list.map((x) => ({ url: x.content_url, size: Number(x.contentSize) || 0, type: x.content_type || '' })),
    });
  }

  // 一覧の読み取りに失敗したときの予備: 止めた fetch の URL から組み立てる
  function startFromStrayUrls() {
    const urls = strayR2;
    strayR2 = [];
    if (!urls.length) return;
    const meta = readSearchResult();
    if (job && meta && job.id === String(meta.id)) return; // 一覧から開始済み
    const id = meta ? String(meta.id) : 'unknown_' + Date.now();
    beginJob({
      id,
      name: safeName(meta && meta.name) || 'photocapsule',
      coin: isCoin(null, meta),
      files: urls.map((u) => ({ url: u, size: 0, type: '' })),
    });
  }

  function readSearchResult() {
    try { return JSON.parse(sessionStorage.getItem('searchResult')); } catch (e) { return null; }
  }

  function isCoin(contentsDownload, meta) {
    if (contentsDownload && String(contentsDownload.is_usecoin) === '1') return true;
    return !!(meta && Number(meta.useCoinCount) > 0);
  }

  // ===== 合言葉の貼り付け =====
  // サイトの入力欄に入れて「受け取る」を押すだけ。検索やコインの確認はサイトに任せる

  // 掲示板からのコピーに付きがちな前後の空白・改行・かっこを取り除く
  function cleanWatchword(text) {
    const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
    return line.replace(/^[「『"'“”]+|[」』"'“”]+$/g, '').trim();
  }

  function findForm() {
    const input = document.querySelector('input.inputKey');
    const btn = document.getElementById('submit-btn');
    return input && btn ? { input, btn } : null;
  }

  // React の入力欄なので、値を入れたあと input イベントで知らせる
  function fillInput(input, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    desc.set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 戻り値: 'sent' 送った / 'moved' 別のページへ移った / 'failed' 入れられなかった
  async function submitWatchword(w) {
    if (!findForm()) {
      try { sessionStorage.setItem(PENDING_KEY, w); } catch (e) { /* ignore */ }
      location.assign('/');
      return 'moved';
    }
    const since = Date.now();
    // 読み込み直後はサイトの準備ができておらず押しても反応しないので、検索が始まるまで繰り返す
    for (let t = 0; t < 10; t++) {
      const f = findForm();
      if (!f) return 'moved'; // ログイン画面などへ移った
      fillInput(f.input, w);
      await sleep(80);
      f.btn.click();
      for (let k = 0; k < 8; k++) {
        await sleep(150);
        if (searchSentAt >= since) return 'sent';
        if (!findForm()) return 'moved';
      }
    }
    return 'failed';
  }

  function takePendingWatchword() {
    try {
      const w = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
      return w || '';
    } catch (e) { return ''; }
  }

  function onSearchResponse(json) {
    if (!ui) return;
    const data = json && json.data;
    if (json && json.success && Array.isArray(data) && !data.length) ui.note('ng', 'その合言葉は見つかりませんでした。コピーした文字が合っているか確認してください。');
    else ui.note(null);
  }

  // ===== ファイル名 =====

  function safeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 60);
  }

  const TYPE_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
    'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/3gpp': '3gp',
  };
  function extOf(url, type) {
    const m = urlKey(url).match(/\.([A-Za-z0-9]{1,5})$/);
    if (m) return m[1].toLowerCase();
    return TYPE_EXT[String(type).toLowerCase()] || 'bin';
  }

  // ===== 保存先フォルダ =====
  // フォルダの参照は GM_setValue に入らないので、サイト側の IndexedDB に置く

  const dirStore = {
    db() {
      return new Promise((res, rej) => {
        const r = W.indexedDB.open('pcseq', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async get() {
      const db = await this.db();
      return new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get('dir');
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => rej(q.error);
      });
    },
    async set(h) {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(h, 'dir');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
  };

  const dir = {
    stored: null,   // 前回選んだフォルダ(許可はまだかもしれない)
    granted: null,  // 書き込みを許可済みのフォルダ
    supported: typeof W.showDirectoryPicker === 'function',

    async load() {
      try { this.stored = await dirStore.get(); } catch (e) { this.stored = null; }
      await this.check();
    },
    async check() {
      this.granted = null;
      if (!this.stored) return false;
      try {
        if ((await this.stored.queryPermission({ mode: 'readwrite' })) === 'granted') this.granted = this.stored;
      } catch (e) { /* ignore */ }
      return !!this.granted;
    },
    // ボタンのクリック中に呼ぶこと(ブラウザがクリック直後しか確認画面を出さないため)
    async request(pickNew) {
      let h = pickNew ? null : this.stored;
      if (h && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
      if (!h) {
        h = await W.showDirectoryPicker({ id: 'pcseq', mode: 'readwrite', startIn: 'downloads' });
        try { await dirStore.set(h); } catch (e) { /* 次回また選ぶだけ */ }
      }
      this.stored = h;
      this.granted = h;
      return h;
    },
  };

  const dirReady = dir.load(); // 前回のフォルダを読み込んでおく

  // 保存方式: 'folder' = 選んだフォルダへ書き込む / 'download' = ダウンロードとして保存する
  const getMode = () => {
    const m = GM_getValue('saveMode', dir.supported ? 'folder' : 'download');
    return m === 'folder' && dir.supported ? 'folder' : 'download';
  };
  const downloadPath = (j) => `${CFG.downloadRoot}/${j.name}`;

  // ===== 保存済み状態 =====

  function saveJob(j) {
    GM_setValue(STORE_PREFIX + j.id, {
      id: j.id, name: j.name, coin: j.coin, updatedAt: Date.now(),
      items: j.items.map((i) => ({ key: i.key, file: i.file, size: i.size, status: i.status === 'done' ? 'done' : i.status === 'error' ? 'error' : 'wait' })),
    });
  }
  function loadJob(id) { return GM_getValue(STORE_PREFIX + id, null); }
  function deleteJob(id) { GM_deleteValue(STORE_PREFIX + id); }
  // すべて保存し終わった受信の記録は、FINISHED_KEEP_DAYS 日たったら消す(保存領域が増え続けないように)
  const FINISHED_KEEP_DAYS = 30;
  function pruneFinishedJobs() {
    const limit = Date.now() - FINISHED_KEEP_DAYS * 86400000;
    for (const k of GM_listValues()) {
      if (!k.startsWith(STORE_PREFIX)) continue;
      const s = GM_getValue(k, null);
      if (!s || !s.items || (s.updatedAt < limit && s.items.every((i) => i.status === 'done'))) GM_deleteValue(k);
    }
  }
  try { pruneFinishedJobs(); } catch (e) { console.warn('[pcseq]', e); }

  function listUnfinishedJobs() {
    return GM_listValues()
      .filter((k) => k.startsWith(STORE_PREFIX))
      .map((k) => GM_getValue(k, null))
      .filter((s) => s && s.items && s.items.some((i) => i.status !== 'done'))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ===== ジョブ =====

  function newJobState() {
    return { refreshes: 0, running: false, stopped: false, notice: '', fatal: '', needDir: false, overwrite: false, active: new Map() };
  }

  function makeJob(spec, saved) {
    const pad = String(spec.files.length).length;
    const prevByKey = new Map(((saved && saved.items) || []).map((p) => [p.key, p]));
    const items = spec.files.map((f, i) => {
      const key = urlKey(f.url);
      const prev = prevByKey.get(key);
      return {
        key,
        url: f.url,
        size: f.size || (prev && prev.size) || 0,
        file: `${spec.name}_${String(i + 1).padStart(pad, '0')}.${extOf(f.url, f.type)}`,
        status: prev && prev.status === 'done' ? 'done' : 'wait',
        tries: 0, err: '', loaded: 0, retryAt: 0,
      };
    });
    return { id: spec.id, name: spec.name, coin: spec.coin, items, expiresAt: computeExpiry(spec.files[0].url), ...newJobState() };
  }

  // 保存済みジョブから再開する(URL は無いので最初に取り直す)
  function jobFromSaved(saved) {
    return {
      id: saved.id, name: saved.name, coin: saved.coin, expiresAt: 0,
      items: saved.items.map((p) => ({ ...p, file: baseName(p.file), url: '', status: p.status === 'done' ? 'done' : 'wait', tries: 0, err: '', loaded: 0, retryAt: 0 })),
      ...newJobState(),
    };
  }

  function beginJob(spec) {
    if (job && job.id === spec.id) {
      // 同じ合言葉をもう一度受け取った: 新しい URL を反映して続ける
      applyFreshUrls(job, spec.files.map((f) => f.url));
      job.expiresAt = computeExpiry(spec.files[0].url);
      if (!job.running) runJob(job);
      return;
    }
    if (job) { job.stopped = true; saveJob(job); }
    job = makeJob(spec, loadJob(spec.id));
    saveJob(job);
    ui.show();
    runJob(job);
  }

  function computeExpiry(url) {
    let life = CFG.fallbackLifetimeMs;
    try {
      const e = Number(new URL(url).searchParams.get('X-Amz-Expires'));
      if (e > 0) life = e * 1000;
    } catch (e) { /* ignore */ }
    // 受け取った時刻を起点にする(PCの時計のずれに左右されない)
    return Date.now() + life - CFG.urlMarginMs;
  }

  function applyFreshUrls(j, urls) {
    const byKey = new Map(urls.map((u) => [urlKey(u), u]));
    let matched = 0;
    j.items.forEach((it) => {
      const u = byKey.get(it.key);
      if (u) { it.url = u; matched++; }
    });
    // パスが変わっていた場合は並び順で対応させる
    if (!matched && urls.length === j.items.length) {
      j.items.forEach((it, i) => { it.url = urls[i]; it.key = urlKey(urls[i]); });
    }
  }

  function authHeaders() {
    return {
      'X-PhotoCapsule-UserCode': userCode,
      'X-PhotoCapsule-Plattoform': 'WebApp',
      'X-PhotoCapsule-Version': '2.0.0',
      'X-PhotoCapsule-DevID': '',
    };
  }

  async function refreshUrls(j) {
    if (j.coin) {
      j.notice = 'コインが必要な合言葉のため、URLの自動取り直しはしません。続きは合言葉を入れ直して受け取ってください。';
      return false;
    }
    if (j.refreshes >= CFG.maxRefresh) {
      j.notice = 'URLの取り直し回数が上限に達したので止めました。';
      return false;
    }
    for (let t = 0; !userCode && t < 20; t++) await sleep(500); // 再読み込み直後はログイン処理を待つ
    if (!userCode) {
      j.notice = 'ログイン情報を取得できませんでした。ログインしているか確認し、ページを再読み込みしてから再開してください。';
      return false;
    }
    j.refreshes++;
    j.notice = 'URLを取り直しています…';
    ui.render();
    try {
      const res = await origFetch(`${API}/v1/watchwords/download.json?watchword_id=${encodeURIComponent(j.id)}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const list = json && json.data && json.data.ContentsDownloadDetail;
      if (!Array.isArray(list) || !list.length) throw new Error('ファイル一覧が空でした');
      const urls = list.map((x) => x.content_url);
      applyFreshUrls(j, urls);
      j.expiresAt = computeExpiry(urls[0]);
      j.notice = '';
      return true;
    } catch (e) {
      j.notice = 'URLの取り直しに失敗しました(' + e.message + ')。「再開」でもう一度試せます。';
      return false;
    }
  }

  let wakeFn = null;
  const wake = () => { if (wakeFn) { const f = wakeFn; wakeFn = null; f(); } };
  const waitWake = (ms) => new Promise((r) => { wakeFn = r; setTimeout(r, ms); });

  async function runJob(j) {
    if (j.running) return;
    await dirReady;
    if (getMode() === 'folder' && !(await dir.check())) {
      j.needDir = true; // パネルのボタンで許可してもらってから再開する
      ui.render();
      return;
    }
    j.needDir = false;
    j.running = true;
    j.stopped = false;
    j.fatal = '';
    j.notice = '';
    ui.render();
    try {
      while (!j.stopped) {
        const now = Date.now();
        const next = j.items.find((i) => i.status === 'wait' && i.retryAt <= now);
        if (next && j.active.size < getConcurrency()) {
          if (now > j.expiresAt || !next.url) {
            if (!(await refreshUrls(j))) { j.stopped = true; break; }
            // 取り直した一覧に含まれていないファイルは失敗扱いにする
            j.items.forEach((i) => { if (i.status === 'wait' && !i.url) { i.status = 'error'; i.err = '一覧に見つかりません'; } });
            continue;
          }
          startItem(j, next);
          continue;
        }
        if (!next && !j.active.size && !j.items.some((i) => i.status === 'wait')) break;
        await waitWake(1000);
      }
    } finally {
      j.running = false;
      saveJob(j);
      ui.render();
    }
  }

  function startItem(j, it) {
    it.status = 'run';
    it.tries++;
    it.err = '';
    it.loaded = 0;
    const save = getMode() === 'folder' ? writeToFolder : saveAsDownload;
    const handle = save(j, it, (r) => {
      j.active.delete(it.key);
      if (r.ok) {
        it.status = 'done';
        it.loaded = it.size;
      } else if (r.fatal) {
        it.status = 'wait';
        it.tries--;
        it.err = r.err;
        j.fatal = r.fatal;
        j.stopped = true;
        // 許可が本当に切れたかをブラウザに聞き直す。ファイルのロックなど許可と関係ない失敗で
        // 「許可する」を出すと、押しても確認画面が出ない(もう許可済みなので)
        if (r.lostDir) dir.check().then(() => ui.render());
      } else if (it.tries <= CFG.retries) {
        it.status = 'wait';
        it.err = r.err;
        it.retryAt = Date.now() + 2000 * it.tries;
        if (/HTTP 403/.test(r.err)) j.expiresAt = 0; // 期限切れとみなして取り直す
      } else {
        it.status = 'error';
        it.err = r.err;
      }
      saveJob(j);
      ui.render();
      wake();
    });
    j.active.set(it.key, handle);
    ui.render();
  }

  // 1ファイルを取得して、選んだフォルダ/合言葉名/ に書き込む。
  // createWritable は一時ファイルに書いて close 時に置き換えるので、途中で止まっても中途半端なファイルは残らない
  function writeToFolder(j, it, done) {
    const ac = new AbortController();
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; done(r); } };

    (async () => {
      let writable = null;
      try {
        const folder = await dir.granted.getDirectoryHandle(j.name, { create: true });
        if (it.size && !j.overwrite) {
          // 同じ大きさのファイルが既にあれば保存済みとみなす(記録が消えていても重複しない)
          try {
            const f = await (await folder.getFileHandle(it.file)).getFile();
            if (f.size === it.size) return finish({ ok: true });
          } catch (e) { /* まだ無い */ }
        }
        const res = await origFetch(it.url, { signal: ac.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const len = Number(res.headers.get('content-length'));
        if (len > 0) it.size = len; // 一覧のサイズより実際の値を信じる
        const fh = await folder.getFileHandle(it.file, { create: true });
        writable = await fh.createWritable();
        const counter = new W.TransformStream({
          transform(chunk, ctl) { it.loaded += chunk.byteLength; ui.renderSoon(); ctl.enqueue(chunk); },
        });
        await res.body.pipeThrough(counter).pipeTo(writable, { signal: ac.signal });
        writable = null; // pipeTo が close 済み
        finish({ ok: true });
      } catch (e) {
        if (writable) { try { await writable.abort(); } catch (x) { /* ignore */ } }
        finish({ ok: false, err: errText(e), fatal: fatalOf(e), lostDir: true });
      }
    })();

    return { abort: () => ac.abort() };
  }

  // 1ファイルをダウンロードとして ダウンロード/写真カプセル/合言葉名/ に保存する。
  // 取得と書き込みは Tampermonkey とブラウザが行うので、フォルダの許可は要らない
  function saveAsDownload(j, it, done) {
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; done(r); } };
    const fail = (e) => {
      const code = (e && e.error) || '';
      const d = e && e.details;
      const detail = String((d && typeof d === 'object' ? d.current || d.error : d) || code || 'error');
      // R2 の期限切れは 403。ブラウザは SERVER_FORBIDDEN などで返す
      finish({ ok: false, err: /403|FORBIDDEN/i.test(detail) ? 'HTTP 403' : detail, fatal: DL_FATAL[code] || '' });
    };
    let req = null;
    try {
      req = GM_download({
        url: it.url,
        name: `${downloadPath(j)}/${it.file}`,
        saveAs: false,
        conflictAction: 'overwrite', // 取り直したときに「(1)」付きの重複を作らない
        onprogress: (e) => {
          if (e && e.total > 0) it.size = e.total;
          if (e && e.loaded >= 0) it.loaded = e.loaded;
          ui.renderSoon();
        },
        onload: () => finish({ ok: true }),
        onerror: fail,
        ontimeout: () => finish({ ok: false, err: 'タイムアウト' }),
      });
    } catch (e) {
      fail({ error: 'not_supported', details: e && e.message });
    }
    return { abort: () => { try { if (req && req.abort) req.abort(); } catch (e) { /* ignore */ } } };
  }

  // 再試行しても直らない GM_download のエラー
  const DL_FATAL = {
    not_enabled: 'Tampermonkey のダウンロード機能が無効です。Tampermonkey の設定（設定モード「上級者」）の「ダウンロード」で有効にしてください。',
    not_whitelisted: 'この種類のファイルは Tampermonkey に保存を許されていません。Tampermonkey の設定（設定モード「上級者」）の「ダウンロード」にある「ホワイトリストに登録されたファイル拡張子」に jpg・png・mp4・mov・heic などを足してください。',
    not_permitted: 'Tampermonkey にダウンロードの権限がありません。Tampermonkey の設定で権限を許可してください。',
    not_supported: 'この環境ではダウンロードとして保存できません。保存方式を「フォルダに書き込む」に切り替えてください。',
  };

  function errText(e) {
    if (!e) return 'error';
    if (e.name === 'TypeError') return '通信エラー';
    return e.message || e.name || String(e);
  }
  // 再試行しても直らないエラー(保存先の問題)
  function fatalOf(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '保存先フォルダへの書き込み許可が切れました。「許可する」を押してください。';
    if (n === 'NotFoundError') return '保存先フォルダが見つかりません（移動や削除をしましたか？）。保存先の「変更」で選び直してください。';
    if (n === 'QuotaExceededError') return 'ディスクの空きが足りません。空きを作ってから再開してください。';
    if (n === 'NoModificationAllowedError' || n === 'InvalidModificationError') return '保存先のファイルに書き込めません（他のアプリで開いていませんか？）。';
    return '';
  }

  const getConcurrency = () => Math.min(CFG.maxConcurrency, Math.max(1, Number(GM_getValue('concurrency', CFG.defaultConcurrency)) || CFG.defaultConcurrency));

  // ===== 表示 =====

  ui = (function createUI() {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICON = {
      folder: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6l2 2h7.4A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
      pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
      play: 'M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z',
      retry: 'M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 1 0 22 12h-2a8 8 0 1 1-8-8z',
      min: 'M5 11h14v2H5z',
      close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
      chevron: 'M6.4 8.6 12 14.2l5.6-5.6L19 10l-7 7-7-7z',
      down: 'M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4 3.6 3.6zM5 19h14v2H5z',
      check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L21 7.5l-1.4-1.4z',
      alert: 'M11 7h2v7h-2zm0 9h2v2h-2zM12 2 1 21h22z',
      paste: 'M9 2h6a1 1 0 0 1 1 1v1h2.5A1.5 1.5 0 0 1 20 5.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20.5v-15A1.5 1.5 0 0 1 5.5 4H8V3a1 1 0 0 1 1-1zm1 2v2h4V4zM6 6v14h12V6h-2v2H8V6z',
    };
    function icon(name, size) {
      const s = document.createElementNS(SVG_NS, 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('width', String(size || 16));
      s.setAttribute('height', String(size || 16));
      s.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', ICON[name]);
      p.setAttribute('fill', 'currentColor');
      s.append(p);
      return s;
    }

    const CSS = `
      :host { all: initial; }
      .wrap {
        --accent: #44c1ee; --accent-strong: #1590c2; --accent-soft: #e4f6fd;
        --bg: #ffffff; --bg2: #f3f7f9; --fg: #1d2a33; --muted: #6b7a85; --line: #e1e8ed;
        --ok: #2e9e5b; --ok-soft: #e4f5eb; --ng: #d64545; --ng-soft: #fdeaea; --warn: #b8730a; --warn-soft: #fdf2df;
        --shadow: 0 10px 30px rgba(16, 42, 60, .18), 0 2px 6px rgba(16, 42, 60, .08);
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
        color: var(--fg); -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        .wrap {
          --accent-strong: #74d3f5; --accent-soft: #163a4a;
          --bg: #1b2228; --bg2: #252e35; --fg: #e5ecf1; --muted: #94a4af; --line: #34414b;
          --ok: #5ccb8a; --ok-soft: #173426; --ng: #f07b7b; --ng-soft: #3d2023; --warn: #f0b85a; --warn-soft: #3a2c14;
          --shadow: 0 10px 30px rgba(0, 0, 0, .45), 0 2px 6px rgba(0, 0, 0, .3);
        }
      }
      * { box-sizing: border-box; }
      button, select { font: inherit; }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      .card { width: 330px; max-width: calc(100vw - 24px); background: var(--bg); border: 1px solid var(--line);
              border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 6px; padding: 9px 8px 9px 14px; color: #fff;
              background: linear-gradient(135deg, #4cc6f0, #229fd6); cursor: grab; user-select: none; touch-action: none; }
      .head.dragging, .pill.dragging { cursor: grabbing; }
      .head .t { flex: 1; display: flex; align-items: center; gap: 7px; font-weight: 700; letter-spacing: .02em; }
      .ib { all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; cursor: pointer; }
      .ib:hover { background: rgba(255, 255, 255, .22); }

      .sec { padding: 12px 14px 14px; }
      .dir { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--bg2); border-radius: 10px; color: var(--muted); }
      .dir .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
      .dir.need { background: var(--warn-soft); color: var(--warn); }
      .dir.need .n { color: var(--warn); font-weight: 600; }
      .link { all: unset; cursor: pointer; font-size: 12px; font-weight: 700; color: var(--accent-strong); white-space: nowrap; }
      .link:hover { text-decoration: underline; }
      .hint { margin-top: 6px; font-size: 11.5px; color: var(--muted); }
      .seg { display: flex; gap: 2px; padding: 2px; margin-bottom: 8px; background: var(--bg2); border-radius: 9px; }
      .seg button { all: unset; flex: 1; text-align: center; padding: 4px 6px; border-radius: 7px; cursor: pointer;
                    font-size: 12px; font-weight: 700; color: var(--muted); }
      .seg button:hover:not([disabled]) { color: var(--fg); }
      .seg button[aria-pressed="true"] { background: var(--bg); color: var(--accent-strong); box-shadow: 0 1px 3px rgba(16, 42, 60, .15); }
      .seg button[disabled] { cursor: default; opacity: .6; }
      .seg button[aria-pressed="true"][disabled] { opacity: 1; }

      .title { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
      .title b { flex: 1; min-width: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip { flex: none; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700;
              background: var(--accent-soft); color: var(--accent-strong); }
      .chip.ok { background: var(--ok-soft); color: var(--ok); }
      .chip.ng { background: var(--ng-soft); color: var(--ng); }
      .chip.warn { background: var(--warn-soft); color: var(--warn); }
      .chip.idle { background: var(--bg2); color: var(--muted); }

      .bar { position: relative; height: 10px; margin: 10px 0 7px; background: var(--bg2); border-radius: 999px; overflow: hidden; }
      .bar i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: linear-gradient(90deg, #4cc6f0, #229fd6); transition: width .4s ease; }
      .bar.ok i { background: var(--ok); }
      .bar.run i::after { content: ""; position: absolute; inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .45), transparent); animation: shine 1.6s linear infinite; }
      @keyframes shine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
      .stats { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .stats .pct { color: var(--fg); font-weight: 700; }

      .msg { display: flex; gap: 7px; margin-top: 10px; padding: 8px 10px; border-radius: 10px; font-size: 12px; }
      .msg svg { flex: none; margin-top: 1px; }
      .msg.ok { background: var(--ok-soft); color: var(--ok); }
      .msg.ng { background: var(--ng-soft); color: var(--ng); }
      .msg.warn { background: var(--warn-soft); color: var(--warn); }
      .msg.info { background: var(--bg2); color: var(--muted); }

      .ctl { display: flex; align-items: center; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
      .sp { flex: 1; }
      .tools { display: flex; align-items: center; gap: 4px; margin-left: auto; white-space: nowrap; }
      .btn { all: unset; display: inline-flex; align-items: center; gap: 5px; padding: 6px 11px; border-radius: 8px; cursor: pointer;
             font-size: 12px; font-weight: 700; background: var(--bg2); color: var(--fg); border: 1px solid var(--line); }
      .btn:hover { border-color: var(--accent); }
      .btn.primary { background: var(--accent); border-color: transparent; color: #fff; }
      .btn.primary:hover { background: #229fd6; }
      .btn.ghost { background: transparent; border-color: transparent; color: var(--muted); padding: 6px 6px; }
      .btn.ghost:hover { color: var(--fg); }
      .btn.wide { display: flex; justify-content: center; box-sizing: border-box; width: 100%; padding: 8px 11px; font-size: 13px; }
      .btn[aria-disabled="true"] { opacity: .6; cursor: default; }
      .paste { margin-top: 10px; }
      .paste .msg { margin-top: 8px; }
      .btn .rot { transition: transform .2s; }
      .btn.open .rot { transform: rotate(180deg); }
      .conc { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
      select { color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; cursor: pointer; }

      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap: 4px;
              max-height: 236px; overflow: auto; padding: 10px 14px 14px; border-top: 1px solid var(--line); }
      .tile { position: relative; aspect-ratio: 1; display: grid; place-items: center; border-radius: 7px;
              font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; background: var(--bg2); color: var(--muted); }
      .tile > span { position: relative; z-index: 1; }
      .tile.done { background: var(--accent-soft); color: var(--accent-strong); }
      .tile.run { background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--line) 0); color: var(--fg); }
      .tile.run::before { content: ""; position: absolute; inset: 3px; border-radius: 5px; background: var(--bg); }
      .tile.retry { background: var(--warn-soft); color: var(--warn); }
      .tile.err { background: var(--ng-soft); color: var(--ng); box-shadow: inset 0 0 0 1.5px var(--ng); cursor: pointer; }
      .tile.err:hover { background: var(--ng); color: #fff; }
      .legend { display: flex; gap: 10px; flex-wrap: wrap; padding: 0 14px 12px; font-size: 11px; color: var(--muted); }
      .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }

      .job { margin-top: 10px; padding: 9px 10px; background: var(--bg2); border-radius: 10px; }
      .job .row1 { display: flex; align-items: center; gap: 8px; }
      .job b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .job .sub { font-size: 11.5px; color: var(--muted); }
      .job .ctl { margin-top: 6px; }
      .empty { margin-top: 12px; font-size: 12px; color: var(--muted); text-align: center; padding: 6px 0 2px; }

      .pill { display: flex; align-items: center; gap: 8px; padding: 5px 14px 5px 5px; background: var(--bg); border: 1px solid var(--line);
              border-radius: 999px; box-shadow: var(--shadow); cursor: pointer; user-select: none; touch-action: none;
              font-weight: 700; font-variant-numeric: tabular-nums; }
      .ring { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%;
              background: conic-gradient(var(--ring, var(--accent)) calc(var(--p) * 1%), var(--line) 0); }
      .ring::before { content: ""; grid-area: 1 / 1; width: 24px; height: 24px; border-radius: 50%; background: var(--bg); }
      .ring svg { grid-area: 1 / 1; position: relative; color: var(--ring, var(--accent-strong)); }
      .pill.ok { --ring: var(--ok); } .pill.ng { --ring: var(--ng); } .pill.warn { --ring: var(--warn); }
      [hidden] { display: none !important; }
      @media (prefers-reduced-motion: reduce) { .bar i { transition: none; } .bar.run i::after { animation: none; } }
    `;

    function el(tag, props, ...kids) {
      const e = document.createElement(tag);
      if (props) Object.entries(props).forEach(([k, v]) => {
        if (v == null || v === false) return;
        if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'className') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else e.setAttribute(k, v === true ? '' : v);
      });
      kids.flat().forEach((k) => k != null && k !== false && e.append(k));
      return e;
    }
    const button = (label, fn, cls, ic) => el('button', { className: 'btn ' + (cls || ''), type: 'button', onclick: fn }, ic ? icon(ic, 14) : null, label);

    // ---- 静的な骨組み ----
    let host = null;
    let wrap, card, pill, body, ctlRow, ctlBtns, gridBtn, grid, legend, sel;
    let pending = false;
    let pasteNote = null; // { cls, text } 貼り付けボタンの下に出す知らせ
    let pasting = false;
    let pos = GM_getValue('pos', null);
    let minimized = !!GM_getValue('minimized', false);
    let gridOpen = !!GM_getValue('gridOpen', false);

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });

      sel = el('select', { title: '同時に保存する本数', 'aria-label': '同時に保存する本数',
        onchange: (e) => { GM_setValue('concurrency', Number(e.target.value)); wake(); } });
      for (let n = 1; n <= CFG.maxConcurrency; n++) sel.append(el('option', { value: String(n) }, String(n)));
      sel.value = String(getConcurrency());

      const head = el('div', { className: 'head' },
        el('div', { className: 't' }, icon('down', 16), '順次ダウンローダー'),
        el('button', { className: 'ib', type: 'button', title: '最小化', 'aria-label': '最小化', onclick: () => setMinimized(true) }, icon('min', 16)),
        el('button', { className: 'ib', type: 'button', title: '閉じる（保存は続きます）', 'aria-label': '閉じる', onclick: hide }, icon('close', 16)));

      body = el('div');
      ctlBtns = el('div', { style: 'display:contents' });
      gridBtn = el('button', { className: 'btn ghost', type: 'button', title: 'ファイルごとの状態',
        onclick: () => { gridOpen = !gridOpen; GM_setValue('gridOpen', gridOpen); render(); } }, '一覧', el('span', { className: 'rot' }, icon('chevron', 14)));
      ctlRow = el('div', { className: 'ctl' }, ctlBtns, el('div', { className: 'tools' }, el('label', { className: 'conc' }, '同時', sel), gridBtn));
      grid = el('div', { className: 'grid' });
      grid.addEventListener('click', onTileClick);
      legend = el('div', { className: 'legend' },
        el('span', null, el('i', { style: 'background:var(--accent-soft)' }), '保存済み'),
        el('span', null, el('i', { style: 'background:var(--accent)' }), '保存中'),
        el('span', null, el('i', { style: 'background:var(--warn-soft)' }), '再試行待ち'),
        el('span', null, el('i', { style: 'background:var(--ng)' }), '失敗（押すと再試行）'));

      card = el('div', { className: 'card', role: 'region', 'aria-label': '順次ダウンローダー' },
        head, el('div', { className: 'sec' }, body, ctlRow), grid, legend);
      pill = el('div', { className: 'pill', role: 'button', tabindex: '0', title: 'クリックで開く',
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMinimized(false); } } });
      wrap = el('div', { className: 'wrap' }, card, pill);
      root.append(el('style', null, CSS), wrap);

      draggable(head, null);
      draggable(pill, () => setMinimized(false));
      window.addEventListener('resize', () => applyPos());
      document.documentElement.append(host);
      applyPos();
    }

    // ---- 位置の移動 ----
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    function applyPos() {
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const right = clamp(pos ? pos.right : 16, 4, Math.max(4, innerWidth - r.width - 4));
      const bottom = clamp(pos ? pos.bottom : 16, 4, Math.max(4, innerHeight - r.height - 4));
      wrap.style.right = right + 'px';
      wrap.style.bottom = bottom + 'px';
      return { right, bottom };
    }
    function draggable(handle, onClick) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button, select')) return;
        const start = wrap.getBoundingClientRect();
        const sx = e.clientX;
        const sy = e.clientY;
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 5) return;
          moved = true;
          handle.classList.add('dragging');
          pos = { right: innerWidth - start.right - dx, bottom: innerHeight - start.bottom - dy };
          pos = applyPos();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          handle.classList.remove('dragging');
          if (moved) GM_setValue('pos', pos);
          else if (onClick) onClick();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    }

    function setMinimized(v) {
      minimized = v;
      GM_setValue('minimized', v);
      render();
    }

    function show() {
      const go = () => { ensure(); host.style.display = ''; render(); };
      if (document.documentElement) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
    }
    function hide() { if (host) host.style.display = 'none'; }

    function renderSoon() {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; render(); }, 250);
    }

    // ---- 速度と残り時間 ----
    let samples = [];
    let sampledJob = null;
    function bytesOf(j) {
      const all = j.items.reduce((s, i) => s + (i.size || 0), 0);
      const got = j.items.reduce((s, i) => s + (i.status === 'done' ? i.size || 0 : i.status === 'run' ? i.loaded || 0 : 0), 0);
      return { all, got };
    }
    // 保存済みファイルの分は数えず、実際に受け取ったバイト数で測る
    let transferred = 0;
    const lastLoaded = new Map();
    function sample(j) {
      if (sampledJob !== j) { sampledJob = j; samples = []; transferred = 0; lastLoaded.clear(); }
      j.items.forEach((i) => {
        if (i.status !== 'run' && !lastLoaded.has(i.key)) return;
        const now = i.status === 'run' ? i.loaded || 0 : i.size || 0;
        const prev = lastLoaded.get(i.key) || 0;
        if (now > prev) transferred += now - prev;
        if (i.status === 'run') lastLoaded.set(i.key, now); else lastLoaded.delete(i.key);
      });
      const t = Date.now();
      samples.push({ t, b: transferred });
      while (samples.length > 2 && t - samples[0].t > 8000) samples.shift();
    }
    function speedOf() {
      if (samples.length < 2) return 0;
      const a = samples[0];
      const z = samples[samples.length - 1];
      const dt = (z.t - a.t) / 1000;
      return dt >= 1.5 ? Math.max(0, (z.b - a.b) / dt) : 0;
    }
    setInterval(() => {
      if (job && job.running) { sample(job); render(); }
      else if (sampledJob) { samples = []; }
    }, 1000);

    // ---- 状態の判定 ----
    function statusOf(j) {
      const running = j.items.some((i) => i.status === 'run');
      const waiting = j.items.some((i) => i.status === 'wait');
      const failed = j.items.some((i) => i.status === 'error');
      const finished = !j.running && !running && !waiting;
      if (j.needDir) return { label: '保存先待ち', cls: 'warn' };
      if (j.fatal) return { label: '要対応', cls: 'ng' };
      if (j.running) return { label: '保存中', cls: '' };
      if (finished) return failed ? { label: '一部失敗', cls: 'ng' } : { label: '完了', cls: 'ok' };
      if (j.notice) return { label: '停止', cls: 'warn' };
      return { label: running ? '停止中…' : '一時停止', cls: 'idle' };
    }

    // ---- 描画 ----
    function render() {
      if (!host || !host.isConnected || host.style.display === 'none') return;
      card.hidden = minimized;
      pill.hidden = !minimized;
      if (minimized) renderPill();
      else renderCard();
      applyPos();
    }

    function renderPill() {
      let p = 0;
      let text = '待機中';
      let cls = '';
      let ic = 'down';
      if (job) {
        const { all, got } = bytesOf(job);
        const done = job.items.filter((i) => i.status === 'done').length;
        p = all ? (got / all) * 100 : (done / job.items.length) * 100;
        const st = statusOf(job);
        text = st.cls === 'ok' ? '完了' : job.running ? Math.floor(p) + '%' : st.label;
        cls = st.cls;
        ic = st.cls === 'ok' ? 'check' : st.cls === 'ng' || st.cls === 'warn' ? 'alert' : job.running ? 'down' : 'pause';
      } else if (listUnfinishedJobs().length) {
        text = '途中の受信あり';
        cls = 'warn';
        ic = 'alert';
      }
      pill.className = 'pill ' + cls;
      pill.style.setProperty('--p', String(p));
      pill.replaceChildren(el('span', { className: 'ring' }, icon(ic, 14)), el('span', null, text));
    }

    function renderCard() {
      body.replaceChildren(...[saveView(), pasteView(), ...(job ? jobView(job) : idleView())].filter(Boolean));
      ctlRow.hidden = !job;
      const showGrid = !!job && gridOpen;
      grid.hidden = !showGrid;
      legend.hidden = !showGrid;
      gridBtn.classList.toggle('open', gridOpen);
      if (sel.value !== String(getConcurrency())) sel.value = String(getConcurrency());
      if (job) ctlBtns.replaceChildren(...controls(job));
      if (showGrid) renderGrid(job);
    }

    async function onDirButton(pickNew) {
      try {
        await dir.request(pickNew);
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 選択画面を閉じた
        alert('このフォルダは選べませんでした。ダウンロードフォルダの中に新しいフォルダを作って、それを選んでください。\n(' + (e && e.message) + ')');
        return;
      }
      if (job && !job.running && (job.needDir || job.fatal) && job.items.some((i) => i.status === 'wait')) runJob(job);
      render();
    }

    function setMode(m) {
      if (m === getMode()) return;
      GM_setValue('saveMode', m);
      if (job && !job.running) {
        job.needDir = false;
        job.fatal = '';
        if (job.items.some((i) => i.status === 'wait')) runJob(job);
      }
      render();
    }

    // 保存方式の切り替え。保存中は混ざらないように切り替えさせない
    function modeView() {
      const m = getMode();
      const busy = !!(job && job.running);
      const opt = (v, label) => el('button', { type: 'button', 'aria-pressed': String(m === v),
        disabled: busy || (v === 'folder' && !dir.supported),
        title: busy ? '一時停止すると切り替えられます' : null, onclick: () => setMode(v) }, label);
      return el('div', { className: 'seg', role: 'group', 'aria-label': '保存方式' },
        opt('download', 'ダウンロードとして保存'), opt('folder', 'フォルダに書き込む'));
    }

    function saveView() {
      if (getMode() === 'download') {
        return el('div', null, modeView(),
          el('div', { className: 'dir' }, icon('folder', 16),
            el('span', { className: 'n', title: `ダウンロード/${CFG.downloadRoot}` }, `ダウンロード / ${CFG.downloadRoot}`)),
          job ? null : el('div', { className: 'hint' }, '許可の確認なしで保存します。ファイル名を変える拡張機能を入れている場合は「フォルダに書き込む」を使ってください。'));
      }
      return el('div', null, modeView(), dirView());
    }

    function dirView() {
      if (dir.granted) {
        return el('div', { className: 'dir' }, icon('folder', 16),
          el('span', { className: 'n', title: dir.granted.name }, dir.granted.name),
          el('button', { className: 'link', type: 'button', onclick: () => onDirButton(true) }, '変更'));
      }
      if (dir.stored) {
        return el('div', { className: 'dir need' }, icon('folder', 16),
          el('span', { className: 'n', title: dir.stored.name }, `${dir.stored.name}（許可が必要）`),
          el('button', { className: 'link', type: 'button', onclick: () => onDirButton(true) }, '変更'),
          button('許可する', () => onDirButton(false), 'primary'));
      }
      return el('div', null,
        el('div', { className: 'dir need' }, icon('folder', 16), el('span', { className: 'n' }, '保存先が未設定'),
          button('保存先を選ぶ', () => onDirButton(true), 'primary')),
        el('div', { className: 'hint' }, 'ダウンロードフォルダそのものは Chrome の制限で選べません。選択画面の「新しいフォルダー」で中にフォルダ（例: 写真カプセル）を作り、それを選んでください。'));
    }

    // ---- 貼り付けて受け取る ----
    function note(cls, text) {
      pasteNote = cls ? { cls, text } : null;
      render();
    }

    async function onPaste() {
      if (pasting) return;
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        note('ng', 'クリップボードを読めませんでした。アドレスバーの左のアイコンから、このサイトの「クリップボード」を「許可」にしてください。');
        return;
      }
      const w = cleanWatchword(text);
      if (!w) { note('warn', 'クリップボードが空です。掲示板で合言葉をコピーしてから押してください。'); return; }
      if (w.length > WATCHWORD_MAX) { note('warn', `コピーした文字が長すぎます（合言葉は${WATCHWORD_MAX}文字まで）。合言葉だけをコピーしてください。`); return; }
      pasting = true;
      note('info', `「${w}」で受け取ります…`);
      const r = await submitWatchword(w);
      pasting = false;
      if (r === 'failed') note('ng', `サイトの入力欄に入れられませんでした。「${w}」を手で入れて「受け取る」を押してください。`);
      else render();
    }

    function pasteView() {
      if (job && job.running) return null; // 保存中に押すと今の保存が止まるので出さない
      return el('div', { className: 'paste' },
        el('button', { className: 'btn primary wide', type: 'button', 'aria-disabled': String(pasting),
          title: 'クリップボードの合言葉をサイトに入れて「受け取る」を押します', onclick: onPaste }, icon('paste', 15), '貼り付けて受け取る'),
        pasteNote ? el('div', { className: 'msg ' + pasteNote.cls }, icon(pasteNote.cls === 'info' ? 'down' : 'alert', 14), el('span', null, pasteNote.text)) : null);
    }

    function idleView() {
      const jobs = listUnfinishedJobs();
      if (!jobs.length) return [el('div', { className: 'empty' }, '掲示板で合言葉をコピーして、上のボタンを押すと受け取れます。')];
      return [
        el('div', { className: 'msg warn' }, icon('alert', 14), '途中で止まった受信があります。'),
        ...jobs.slice(0, 5).map((s) => {
          const left = s.items.filter((i) => i.status !== 'done').length;
          return el('div', { className: 'job' },
            el('div', { className: 'row1' }, el('b', { title: s.name }, s.name), s.coin ? el('span', { className: 'chip warn' }, 'コイン') : null),
            el('div', { className: 'sub' }, `残り ${left} / ${s.items.length} 件`),
            el('div', { className: 'ctl' },
              s.coin ? el('span', { className: 'sub' }, '合言葉を入れ直すと続きから保存します')
                : button('再開', () => { job = jobFromSaved(s); runJob(job); render(); }, 'primary', 'play'),
              el('span', { className: 'sp' }),
              button('記録を消す', () => { deleteJob(s.id); render(); }, 'ghost')));
        }),
      ];
    }

    function jobView(j) {
      const total = j.items.length;
      const done = j.items.filter((i) => i.status === 'done').length;
      const failed = j.items.filter((i) => i.status === 'error').length;
      const running = j.items.filter((i) => i.status === 'run').length;
      const waiting = j.items.some((i) => i.status === 'wait');
      const { all, got } = bytesOf(j);
      const pct = all ? (got / all) * 100 : total ? (done / total) * 100 : 0;
      const finished = !j.running && !running && !waiting;
      const st = statusOf(j);
      const dirName = getMode() === 'download' ? `ダウンロード/${CFG.downloadRoot}` : dir.granted ? dir.granted.name : dir.stored ? dir.stored.name : '保存先';

      let rate = '';
      if (j.running) {
        const sp = speedOf();
        rate = sp > 0 ? `${fmtBytes(sp)}/s` + (all && got < all ? ` ・ 残り${fmtDur((all - got) / sp)}` : '') : '速度を計測中…';
      }

      const out = [
        el('div', { className: 'title' }, el('b', { title: j.name }, j.name), el('span', { className: 'chip ' + st.cls }, st.label)),
        el('div', { className: `bar ${finished && !failed ? 'ok' : ''} ${j.running ? 'run' : ''}`, role: 'progressbar',
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.floor(pct)) },
          el('i', { style: `width:${pct.toFixed(1)}%` })),
        el('div', { className: 'stats' },
          el('span', null, el('span', { className: 'pct' }, Math.floor(pct) + '%'), `  ${done} / ${total} 件`),
          el('span', null, all ? `${fmtBytes(got)} / ${fmtBytes(all)}` : '')),
        rate ? el('div', { className: 'stats' }, el('span', null, rate), el('span', null, `実行中 ${running}`)) : null,
      ];

      const msg = (cls, ic, text) => el('div', { className: 'msg ' + cls }, icon(ic, 14), el('span', null, text));
      if (j.needDir) out.push(msg('warn', 'folder', '上のボタンで保存先を選ぶ（または許可する）と、保存が始まります。'));
      if (j.fatal) out.push(msg('ng', 'alert', j.fatal));
      if (j.notice) out.push(msg('warn', 'alert', j.notice));
      if (finished && !failed) out.push(msg('ok', 'check', `すべて保存しました（${dirName} / ${j.name}）`));
      if (finished && failed) out.push(msg('ng', 'alert', `${failed} 件を保存できませんでした。「失敗分を再試行」か、一覧の赤いタイルを押すと取り直せます。`));
      if (!j.running && running) out.push(msg('info', 'pause', `一時停止しました。実行中の ${running} 件は最後まで保存します。`));
      return out;
    }

    function controls(j) {
      const running = j.items.some((i) => i.status === 'run');
      const waiting = j.items.some((i) => i.status === 'wait');
      const failed = j.items.filter((i) => i.status === 'error');
      const finished = !j.running && !running && !waiting;
      const out = [];
      if (j.running) out.push(button('一時停止', () => { j.stopped = true; wake(); render(); }, '', 'pause'));
      else if (waiting && !j.needDir && !(j.coin && Date.now() > j.expiresAt)) out.push(button('再開', () => runJob(j), 'primary', 'play'));
      if (failed.length) out.push(button('失敗分を再試行', () => retry(j, failed), j.running ? '' : 'primary', 'retry'));
      if (finished && !failed.length) {
        out.push(button('閉じる', () => { job = null; render(); }, 'primary'));
        out.push(button('取り直す', () => {
          if (!confirm('保存済みのファイルも含めて、もう一度すべて保存し直しますか？')) return;
          j.overwrite = true;
          retry(j, j.items);
        }, 'ghost'));
      } else if (!j.running && !running) {
        out.push(button('閉じる', () => { job = null; render(); }, 'ghost'));
      }
      return out;
    }

    function retry(j, list) {
      list.forEach((i) => { i.status = 'wait'; i.tries = 0; i.retryAt = 0; });
      if (j.running) wake(); else runJob(j);
      render();
    }

    function onTileClick(e) {
      const t = e.target.closest('.tile.err');
      if (!t || !job) return;
      const it = job.items[Number(t.dataset.i)];
      if (it && it.status === 'error') retry(job, [it]);
    }

    // タイルは作り直さず、変わった所だけ書き換える(ファイルが多いと毎回の作り直しが重いため)
    function renderGrid(j) {
      const stateText = { done: '保存済み', run: '保存中', wait: '待機中', error: '失敗' };
      if (grid.childElementCount !== j.items.length || grid.dataset.job !== j.id) {
        grid.dataset.job = j.id;
        grid.replaceChildren(...j.items.map((it, idx) =>
          el('div', { className: 'tile', 'data-i': String(idx) }, el('span', null, String(idx + 1)))));
      }
      const tiles = grid.children;
      j.items.forEach((it, idx) => {
        let cls = 'tile';
        let p = '';
        if (it.status === 'done') cls += ' done';
        else if (it.status === 'run') { cls += ' run'; p = String(it.size ? Math.floor(((it.loaded || 0) / it.size) * 100) : 0); }
        else if (it.status === 'error') cls += ' err';
        else if (it.err) cls += ' retry';
        const tip = `${it.file}\n${stateText[it.status] || ''}${it.err ? '（' + it.err + '）' : ''}${it.status === 'error' ? '\nクリックで再試行' : ''}`;
        const t = tiles[idx];
        if (t.className !== cls) t.className = cls;
        if (t.style.getPropertyValue('--p') !== p) { if (p) t.style.setProperty('--p', p); else t.style.removeProperty('--p'); }
        if (t.title !== tip) t.title = tip;
      });
    }

    function fmtBytes(n) {
      if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
      return Math.max(1, Math.ceil(n / 1e3)) + ' KB';
    }
    function fmtDur(sec) {
      if (!isFinite(sec)) return '';
      if (sec < 60) return '約' + Math.max(1, Math.ceil(sec)) + '秒';
      if (sec < 3600) return '約' + Math.ceil(sec / 60) + '分';
      return '約' + Math.floor(sec / 3600) + '時間' + Math.round((sec % 3600) / 60) + '分';
    }

    return { show, hide, render, renderSoon, note };
  })();

  GM_registerMenuCommand('進み具合のパネルを表示', () => ui.show());

  // 保存中にタブを閉じたり別のページへ移ろうとしたら、ブラウザの確認を出す
  // （続きからの再開はできるが、保存中のファイルは最初から取り直しになる）
  window.addEventListener('beforeunload', (e) => {
    if (!job || !(job.running || job.items.some((i) => i.status === 'run'))) return;
    e.preventDefault();
    e.returnValue = ''; // 古いブラウザ向け
  });

  // 起動時: 前回のフォルダを読み込んでからパネルを出す（「貼り付けて受け取る」をいつでも押せるように）
  // Tampermonkey はブラウザ起動直後などに、ページの読み込みが終わってからスクリプトを動かすことがある。
  // そのときは DOMContentLoaded がもう来ないので、すぐに始める
  const onReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  onReady(async () => {
    await dirReady;
    ui.show();
    const w = takePendingWatchword(); // 別のページで「貼り付けて受け取る」を押した続き
    if (w) {
      ui.note('info', `「${w}」で受け取ります…`);
      const r = await submitWatchword(w);
      if (r === 'failed') ui.note('ng', `サイトの入力欄に入れられませんでした。「${w}」を手で入れて「受け取る」を押してください。`);
    }
  });
})();
