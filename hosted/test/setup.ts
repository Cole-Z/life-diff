// Match hosted/wrangler.toml so the OAuth library does not warn that CIMD is off.
(globalThis as unknown as { Cloudflare: Cloudflare }).Cloudflare = {
  compatibilityFlags: { global_fetch_strictly_public: true },
};
