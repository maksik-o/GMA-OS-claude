const NAME = 'running-list', VER = 6;
let _db = null;
let _opening = null;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('tasks')) d.createObjectStore('tasks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('finance')) d.createObjectStore('finance', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kb')) d.createObjectStore('kb', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kbfiles')) d.createObjectStore('kbfiles', { keyPath: 'id' });
  };
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = () => { _db = null; _opening = null; };
      d.onversionchange = () => { try { d.close(); } catch {} _db = null; _opening = null; };
      res(d);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IDB blocked'));
  });
}

function db() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = openDB().then(d => { _db = d; _opening = null; return d; })
                    .catch(err => { _opening = null; throw err; });
  return _opening;
}

function req(promise) {
  return promise.then(r => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

export const dbGet = (store, id) => req(db().then(d => d.transaction(store).objectStore(store).get(id)));
export const dbAll = store => req(db().then(d => d.transaction(store).objectStore(store).getAll()));
export const dbPut = (store, val) => req(db().then(d => d.transaction(store, 'readwrite').objectStore(store).put(val)));
export const dbDel = (store, id) => req(db().then(d => d.transaction(store, 'readwrite').objectStore(store).delete(id)));
export const dbGetKV = key => req(db().then(d => d.transaction('kv').objectStore('kv').get(key)));
export const dbSetKV = (key, val) => req(db().then(d => d.transaction('kv', 'readwrite').objectStore('kv').put(val, key)));
export const dbGetFile = id => req(db().then(d => d.transaction('files').objectStore('files').get(id)));
export const dbPutFile = val => req(db().then(d => d.transaction('files', 'readwrite').objectStore('files').put(val)));
export const dbDelFile = id => req(db().then(d => d.transaction('files', 'readwrite').objectStore('files').delete(id)));

// Атомарная замена store: одна транзакция, clear+put вместе
export async function dbBulk(store, items) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    const clearReq = s.clear();
    clearReq.onerror = () => rej(clearReq.error);
    clearReq.onsuccess = () => {
      for (const i of items) {
        try { s.put(i); }
        catch (err) { rej(err); return; }
      }
    };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transaction aborted'));
  });
}
