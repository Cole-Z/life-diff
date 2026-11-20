/**
 * Workers rejects the global `fetch` when `this` is a foreign object
 * (`TypeError: Illegal invocation`). That happens if the function is stored
 * and called as a method (`this.fetch(url)`). Bind it to the global object.
 */
export function bindFetch(impl: typeof fetch = globalThis.fetch): typeof fetch {
  return impl.bind(globalThis);
}
