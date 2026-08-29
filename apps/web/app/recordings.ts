/**
 * Recordings the phone is holding because the server has not acknowledged them
 * yet (story 112).
 *
 * A basement costs signal, not a floor's observations. Every recording is
 * written here **before** it is sent and removed only once the API has
 * answered, so a failed send, a closed tab and a dead battery all leave the
 * audio on the device to be sent when the signal comes back.
 *
 * IndexedDB and not `localStorage`, because this holds audio: a Blob goes in
 * as itself, where `localStorage` would need it base64'd into a five-megabyte
 * string budget shared with everything else.
 *
 * Every read and write is guarded. A private window, a browser set to block
 * site data, or a quota that is full all make this throw, and none of them is
 * a reason for the record button to stop working — the send still happens, it
 * simply has no second chance if it fails.
 */

const DATABASE = 'epmos-recordings';
const STORE = 'unsent';

export interface HeldRecording {
  /** Minted when the recording stopped, and what the API reconciles on. */
  captureKey: string;
  siteVisitId: string;
  recordedAt: string;
  contentType: string;
  audio: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, {
          keyPath: 'captureKey',
        });
        store.createIndex('siteVisitId', 'siteVisitId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Before the first send, so nothing is only ever in flight. */
export async function hold(recording: HeldRecording): Promise<void> {
  const database = await open();
  try {
    await finished(
      database.transaction(STORE, 'readwrite').objectStore(STORE).put(recording),
    );
  } finally {
    database.close();
  }
}

/** After the API has answered — with the row or with a new one, both count. */
export async function release(captureKey: string): Promise<void> {
  const database = await open();
  try {
    await finished(
      database
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .delete(captureKey),
    );
  } finally {
    database.close();
  }
}

/** What this walk is still holding, oldest first. */
export async function held(siteVisitId: string): Promise<HeldRecording[]> {
  const database = await open();
  try {
    const rows = (await finished(
      database
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index('siteVisitId')
        .getAll(siteVisitId),
    )) as HeldRecording[];
    return rows.sort((one, other) =>
      one.recordedAt.localeCompare(other.recordedAt),
    );
  } finally {
    database.close();
  }
}
