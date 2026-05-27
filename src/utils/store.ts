import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";

async function getStore(): Promise<Store> {
  return Store.load(STORE_FILE, { defaults: {} });
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
