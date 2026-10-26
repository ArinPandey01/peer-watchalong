const DATABASE_NAME = 'peer-watchalong-host';
const STORE_NAME = 'media';
const FILE_KEY = 'selected-file';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function saveHostFile(file: File): Promise<IDBValidKey> {
  return transact('readwrite', (store) => store.put(file, FILE_KEY));
}

export async function loadHostFile(): Promise<File | null> {
  const value = await transact('readonly', (store) => store.get(FILE_KEY));
  return value instanceof File ? value : null;
}

export function clearHostFile(): Promise<undefined> {
  return transact('readwrite', (store) => store.delete(FILE_KEY));
}
