const DATABASE_NAME = "timeline-studio-voice-library";
const DATABASE_VERSION = 1;
const PROFILE_STORE = "voice-profiles";
const SETTINGS_STORE = "settings";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        database.createObjectStore(PROFILE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(storeName, mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      // A successful request can still be rolled back before the transaction commits.
      transaction.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new DOMException("Voice library transaction aborted", "AbortError"));
    });
  } finally {
    database.close();
  }
}

export async function listVoiceProfiles() {
  const profiles = await runTransaction(PROFILE_STORE, "readonly", (store) => store.getAll());
  return profiles.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function saveVoiceProfile(profile) {
  await runTransaction(PROFILE_STORE, "readwrite", (store) => store.put(profile));
  return profile;
}

export async function deleteVoiceProfile(profileId) {
  await runTransaction(PROFILE_STORE, "readwrite", (store) => store.delete(profileId));
}

export async function setVoiceProfileFavorite(profileId, favorite) {
  const profile = await runTransaction(PROFILE_STORE, "readonly", (store) => store.get(profileId));
  if (!profile) return null;
  return saveVoiceProfile({ ...profile, favorite: Boolean(favorite), updatedAt: new Date().toISOString() });
}

export async function loadFavoriteBuiltInVoiceIds(defaultValue = []) {
  const record = await runTransaction(SETTINGS_STORE, "readonly", (store) => store.get("favorite-built-in-voices"));
  return Array.isArray(record?.value) ? record.value : defaultValue;
}

export async function saveFavoriteBuiltInVoiceIds(ids) {
  await runTransaction(SETTINGS_STORE, "readwrite", (store) => store.put({ key: "favorite-built-in-voices", value: [...new Set(ids)] }));
}
