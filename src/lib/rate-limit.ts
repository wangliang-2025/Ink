/**
 * In-memory rate limiter.
 *
 * For single-instance deployments this is sufficient. For multi-instance
 * (Vercel / Kubernetes), replace with @upstash/ratelimit + Redis.
 *
 * Each key is tracked with a sliding window: up to `maxRequests` within
 * `windowSeconds`. Excess requests receive a 429 response.
 */

interface WindowEntry {
  timestamps: number[];
}

const store = new Map<string, WindowEntry>();

// Periodic cleanup: purge entries older than 10 minutes every 60 seconds.
// This prevents the map from growing unbounded in long-running processes.
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_ENTRY_AGE_MS = 10 * 60_000;

if (typeof globalThis !== 'undefined') {
  const _global = globalThis as Record<string, unknown>;
  if (!_global.__rateLimitCleanup) {
    _global.__rateLimitCleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of store) {
        // Remove entries whose newest timestamp is older than MAX_ENTRY_AGE
        if (
          entry.timestamps.length === 0 ||
          now - entry.timestamps[entry.timestamps.length - 1] > MAX_ENTRY_AGE_MS
        ) {
          store.delete(key);
        }
      }
    }, CLEANUP_INTERVAL_MS).unref?.() ?? undefined;
  }
}

export interface RateLimitOptions {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Window duration in seconds. */
  windowSeconds: number;
  /** Unique key prefix (e.g. "login", "register", "comment"). */
  keyPrefix: string;
}

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Time in seconds until the window resets. */
  resetInSeconds: number;
}

/**
 * Check if a request identified by `identifier` (usually IP address) is
 * rate-limited.
 */
export function checkRateLimit(
  identifier: string,
  opts: RateLimitOptions
): RateLimitResult {
  const key = `${opts.keyPrefix}:${identifier}`;
  const now = Date.now();
  const windowMs = opts.windowSeconds * 1000;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Remove timestamps outside the current window
  const windowStart = now - windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  const current = entry.timestamps.length;

  if (current >= opts.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const resetInSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, resetInSeconds };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: opts.maxRequests - current - 1,
    resetInSeconds: Math.ceil((entry.timestamps[0] + windowMs - now) / 1000),
  };
}

/**
 * Extract a client identifier from a Request object.
 * Uses X-Forwarded-For header (common behind proxies/load balancers)
 * falling back to a hash of other headers for privacy.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  // Fallback: no reliable IP without proxy, use a combination of headers
  const ua = req.headers.get('user-agent') ?? 'unknown';
  const acceptLang = req.headers.get('accept-language') ?? 'unknown';
  return `direct:${Buffer.from(`${ua}:${acceptLang}`).toString('base64').slice(0, 32)}`;
}

/**
 * Preset configurations for common endpoints.
 */
export const RateLimits = {
  /** 5 requests per 15 minutes — login / password change */
  auth: { maxRequests: 5, windowSeconds: 15 * 60, keyPrefix: 'auth' },
  /** 3 registrations per hour per IP */
  register: { maxRequests: 3, windowSeconds: 60 * 60, keyPrefix: 'register' },
  /** 10 comments per 10 minutes */
  comment: { maxRequests: 10, windowSeconds: 10 * 60, keyPrefix: 'comment' },
  /** 30 general API requests per minute */
  api: { maxRequests: 30, windowSeconds: 60, keyPrefix: 'api' },
} as const satisfies Record<string, RateLimitOptions>;