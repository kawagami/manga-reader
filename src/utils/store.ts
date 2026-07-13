import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  // Reset on failure so the next call retries instead of returning a
  // permanently rejected promise
  storePromise ??= Store.load(STORE_FILE, { defaults: {} }).catch((e) => {
    storePromise = null;
    throw e;
  });
  return storePromise;
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
}

export async function loadSetting<T>(key: string): Promise<T | null> {
  const store = await getStore();
  return (await store.get<T>(key)) ?? null;
}
