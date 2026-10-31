/* ============================================================
   IndexedDB ストレージ
   同一オリジン(moyorieki.github.io)の他アプリ(プロットボード等)と
   名前が衝突しないよう、DB名・localStorageキーは nb / namebuilder 接頭辞で揃える。

   stores:
     docs   : 作品メタ { id, title, createdAt, updatedAt, w, h, pages:[pageId…] }
     pages  : key `${docId}:${pageId}` → { strokes:[stroke…] }
     thumbs : key `${docId}:${pageId}` → Blob(小さなサムネイル画像)
   ============================================================ */

const DB_NAME = 'namebuilder';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

/** 1トランザクションで fn(stores) を実行し、完了(oncomplete)で解決する。
 *  fn の中ではリクエストを同期的に発行すること(awaitを挟むとトランザクションが閉じる) */
async function run(storeNames, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    for (const n of [].concat(storeNames)) stores[n] = t.objectStore(n);
    let result;
    const setResult = (v) => { result = v; };
    fn(stores, setResult);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

const reqTo = (req, set) => { req.onsuccess = () => set(req.result); };
const pkey = (docId, pageId) => `${docId}:${pageId}`;
const docRange = (docId) => IDBKeyRange.bound(`${docId}:`, `${docId}:￿`);

export const listDocs = () => run('docs', 'readonly', (s, set) => reqTo(s.docs.getAll(), set));
export const getDoc = (id) => run('docs', 'readonly', (s, set) => reqTo(s.docs.get(id), set));
export const putDoc = (doc) => run('docs', 'readwrite', (s) => { s.docs.put(doc); });

export const getPage = (docId, pageId) =>
  run('pages', 'readonly', (s, set) => reqTo(s.pages.get(pkey(docId, pageId)), set));

/** 複数ページの本体とサムネ、作品メタを1トランザクションでまとめて保存 */
export function savePages(doc, pageRecords, thumbs) {
  return run(['docs', 'pages', 'thumbs'], 'readwrite', (s) => {
    s.docs.put(doc);
    for (const [pageId, rec] of pageRecords) s.pages.put(rec, pkey(doc.id, pageId));
    for (const [pageId, blob] of thumbs) s.thumbs.put(blob, pkey(doc.id, pageId));
  });
}

export const getThumb = (docId, pageId) =>
  run('thumbs', 'readonly', (s, set) => reqTo(s.thumbs.get(pkey(docId, pageId)), set));

export function deletePageData(docId, pageId) {
  return run(['pages', 'thumbs'], 'readwrite', (s) => {
    s.pages.delete(pkey(docId, pageId));
    s.thumbs.delete(pkey(docId, pageId));
  });
}

export function deleteDoc(docId) {
  return run(['docs', 'pages', 'thumbs'], 'readwrite', (s) => {
    s.docs.delete(docId);
    s.pages.delete(docRange(docId));
    s.thumbs.delete(docRange(docId));
  });
}

/** 作品まるごと複製。ページIDはそのまま使い回せる(キーは docId で分かれる) */
export async function duplicateDoc(src, newDoc) {
  const db = await open();
  const pages = await new Promise((res, rej) => {
    const out = [];
    const t = db.transaction(['pages', 'thumbs'], 'readonly');
    const ps = t.objectStore('pages'), ts = t.objectStore('thumbs');
    for (const pid of src.pages) {
      const item = { pid, rec: null, thumb: null };
      out.push(item);
      reqTo(ps.get(pkey(src.id, pid)), (v) => { item.rec = v; });
      reqTo(ts.get(pkey(src.id, pid)), (v) => { item.thumb = v; });
    }
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
  await run(['docs', 'pages', 'thumbs'], 'readwrite', (s) => {
    s.docs.put(newDoc);
    for (const { pid, rec, thumb } of pages) {
      if (rec) s.pages.put(rec, pkey(newDoc.id, pid));
      if (thumb) s.thumbs.put(thumb, pkey(newDoc.id, pid));
    }
  });
}

/** ブラウザに勝手に消されないよう永続ストレージを要求(Android Chromeは
 *  インストール済みPWA等で許可されやすい)。結果は設定画面に表示する */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (_) { return null; }
}
