// スキャンした画像を端末内(IndexedDB)に保存するためのラッパー。
// クラウド(Firebase Storage)には保存せず、あくまで端末のブラウザ内にのみ保持する。
// イベント終了後、gallery画面からまとめてZIPダウンロードして人間が目視確認する運用を想定。

const DB_NAME = 'livepocket-qr-ocr-test';
const DB_VERSION = 1;
const STORE_NAME = 'scans';

export interface LocalScanRecord {
  id: number; // 自動採番
  rawText: string; // QRの内容
  capturedAt: number; // 撮影時刻(epoch ms)
  imageBlob: Blob; // JPEG画像
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 1件保存する。idは自動採番されるため、呼び出し側では指定しない。
export async function addScanRecord(
  rawText: string,
  capturedAt: number,
  imageBlob: Blob
): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add({ rawText, capturedAt, imageBlob });

    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

// 保存されている全件を、撮影時刻の昇順で取得する。
export async function getAllScanRecords(): Promise<LocalScanRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result as LocalScanRecord[]) ?? [];
      records.sort((a, b) => a.capturedAt - b.capturedAt);
      resolve(records);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

// 保存件数のみを取得する(一覧全体を読み込まずに件数だけ知りたい場合用)。
export async function countScanRecords(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

// 保存されている画像を全件削除する(テストを繰り返す際の端末リセット用)。
export async function clearAllScanRecords(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
