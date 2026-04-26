import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('runtime config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('prefers the configured API base URL', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://saudidex.vercel.app');
    const { getApiBaseUrl } = await import('./runtime');

    expect(getApiBaseUrl()).toBe('https://saudidex.vercel.app/api');
  });

  it('appends /api when configured URL is origin-only', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://saudidex.vercel.app');
    const { getApiBaseUrl } = await import('./runtime');

    expect(getApiBaseUrl()).toBe('https://saudidex.vercel.app/api');
  });

  it('falls back to the browser origin', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.stubGlobal('window', { location: { origin: 'https://saudidex.vercel.app' } });
    const { getApiBaseUrl } = await import('./runtime');

    expect(getApiBaseUrl()).toBe('https://saudidex.vercel.app/api');
  });

  it('detects whether Gemini is configured', async () => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-key');
    const { getGeminiApiKey, isGeminiConfigured } = await import('./runtime');

    expect(getGeminiApiKey()).toBe('test-key');
    expect(isGeminiConfigured()).toBe(true);
  });

  it('treats same-origin production API as local backend mode', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.stubGlobal('window', {
      location: {
        origin: 'https://saudidex.vercel.app',
        hostname: 'saudidex.vercel.app',
      },
    });
    const { getBackendMode } = await import('./runtime');

    expect(getBackendMode()).toBe('local');
  });

  it('treats cross-origin configured API as remote backend mode', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.saudidex.vercel.app');
    vi.stubGlobal('window', {
      location: {
        origin: 'https://saudidex.vercel.app',
        hostname: 'saudidex.vercel.app',
      },
    });
    const { getBackendMode } = await import('./runtime');

    expect(getBackendMode()).toBe('remote');
  });
});
