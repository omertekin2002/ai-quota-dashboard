// Host header allow-list, so other websites can't read the dashboard via DNS rebinding.

// `extra` is the ALLOWED_HOSTS value, e.g. the MagicDNS name when published with `tailscale serve`.
export function parseAllowedHosts(extra = '') {
  return new Set([
    'localhost',
    '127.0.0.1',
    ...extra
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean),
  ]);
}

export function isAllowedHost(hostHeader, allowed) {
  return allowed.has((hostHeader || '').replace(/:\d+$/, '').toLowerCase());
}
