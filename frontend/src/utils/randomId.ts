// crypto.randomUUID() is only available in secure contexts (https or
// localhost). DevGrimoire is often self-hosted over plain HTTP on a LAN
// host/IP, where crypto.randomUUID is undefined and calling it throws.
// Fall back to getRandomValues (still a proper v4 UUID), and finally to a
// non-crypto id — these ids are only used as local React keys / per-tab
// session keys, no cryptographic property is required.
export function safeRandomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // some old Safari throws when not in a secure context — fall through
    }
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
