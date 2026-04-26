type ViteEnv = Record<string, string | undefined>;

const getViteEnv = (): ViteEnv => {
  const meta = import.meta as ImportMeta & { env?: ViteEnv };
  return meta.env ?? {};
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');

const ensureApiPath = (value: string) => {
  const trimmed = trimTrailingSlashes(value);

  // Relative values (e.g. "/api", "/backend-api") should be preserved as-is.
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // Absolute URL values should default to "/api" when only an origin is provided.
  try {
    const parsed = new URL(trimmed);
    const pathname = trimTrailingSlashes(parsed.pathname);
    if (!pathname || pathname === '') {
      parsed.pathname = '/api';
      return trimTrailingSlashes(parsed.toString());
    }
    return trimTrailingSlashes(parsed.toString());
  } catch {
    // Non-URL strings are returned unchanged to avoid surprising rewrites.
    return trimmed;
  }
};

export const getBrowserOrigin = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.location.origin;
};

export const getApiBaseUrl = () => {
  const configuredBaseUrl = getViteEnv().VITE_API_BASE_URL?.trim();
  // Prefer explicit runtime configuration when provided.
  if (configuredBaseUrl) {
    return ensureApiPath(configuredBaseUrl);
  }

  const origin = getBrowserOrigin();
  return origin ? `${origin}/api` : '/api';
};

export const getGeminiApiKey = () => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.GEMINI_API_KEY?.trim() || '';
  }
  return '';
};

export const isGeminiConfigured = () => getGeminiApiKey().length > 0;

/** Check if a custom backend API URL is configured */
export const isBackendConfigured = () => {
  const baseUrl = getViteEnv().VITE_API_BASE_URL?.trim();
  return !!baseUrl;
};

export const getAdminSecret = () => {
  return getViteEnv().VITE_ADMIN_CURSOR_SECRET?.trim() || '';
};

/** Get the backend provider mode: 'local' | 'remote' | 'none' */
export const getBackendMode = (): 'local' | 'remote' | 'none' => {
  if (typeof window === 'undefined') return 'none';
  const { hostname, origin } = window.location;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const configuredBaseUrl = getViteEnv().VITE_API_BASE_URL?.trim();

  if (isLocalhost) return 'local';
  if (!configuredBaseUrl) return origin ? 'local' : 'none';

  try {
    const resolvedUrl = new URL(ensureApiPath(configuredBaseUrl), origin);
    return resolvedUrl.origin === origin ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
};

/**
 * Check if AI providers are enabled.
 * When set to 'true', all AI enrichment/classification endpoints return
 * { status: "ai_disabled" } and the discovery pipeline skips AI extraction.
 *
 * Set via: VITE_AI_DISABLED=true (client) or AI_DISABLED=true (server)
 */
export const isAIEnabled = (): boolean => {
  // Client-side check
  if (typeof window !== 'undefined') {
    const env = getViteEnv();
    return env.VITE_AI_DISABLED !== 'true';
  }

  // Server-side check (Node.js)
  if (typeof process !== 'undefined' && process.env) {
    return process.env.AI_DISABLED !== 'true';
  }

  return true; // Default: AI enabled
};
