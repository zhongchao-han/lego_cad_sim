// 极小 IndexedDB 封装（不引第三方依赖）。
// 只覆盖本项目持久化所需的 keyval 语义：单 DB、两个对象存储。
//  - 'kv'        : 主工作区状态的双槽（slotA/slotB）+ 指针，out-of-line key。
//  - 'snapshots' : 带时间戳的历史快照，keyPath = 'id'。
//
// 为什么不用 localStorage：localStorage 同步阻塞、~5MB 配额、"清缓存"常规操作
// 会整块抹掉。IndexedDB 异步、容量大（几十 MB+）、不随普通清缓存被误删。

export const DB_NAME = 'lego-cad-persist';
export const DB_VERSION = 1;
export const KV_STORE = 'kv';
export const SNAPSHOT_STORE = 'snapshots';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一标签页触发版本升级时主动让路，避免阻塞。
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return _dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onabort = () => reject(t.error ?? new Error('IndexedDB tx aborted'));
        t.onerror = () => reject(t.error ?? new Error('IndexedDB tx error'));
      }),
  );
}

export function idbGet<T = unknown>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbSet(store: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  // keyPath 存储（snapshots）不传 key；out-of-line 存储（kv）传 key。
  return tx<IDBValidKey>(store, 'readwrite', (s) =>
    key === undefined ? s.put(value) : s.put(value, key),
  );
}

export function idbDel(store: string, key: IDBValidKey): Promise<undefined> {
  return tx<undefined>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
}

export function idbGetAll<T = unknown>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}
