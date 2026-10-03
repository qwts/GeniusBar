// Node's own localStorage global shadows jsdom's and is undefined without
// --localstorage-file, so tests get an in-memory one.
if (!globalThis.localStorage) {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}
