import { AppError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses secure local defaults and accepts an optional token', () => {
    const config = loadConfig({ SP_API_TOKEN: ' token ' });

    expect(config.apiUrl.toString()).toBe('http://127.0.0.1:3876/');
    expect(config.apiToken).toBe('token');
    expect(config.apiTimeoutMs).toBe(15_000);
    expect(config.allowNonLoopbackUrl).toBe(false);
  });

  it('rejects non-loopback URLs unless explicitly enabled', () => {
    expect(() => loadConfig({ SP_API_URL: 'http://192.168.1.20:3876' })).toThrow(AppError);

    const config = loadConfig({
      SP_API_URL: 'http://192.168.1.20:3876',
      SP_ALLOW_NON_LOOPBACK_URL: 'true',
    });
    expect(config.apiUrl.hostname).toBe('192.168.1.20');
  });

  it('uses the enhanced semantic API by default and accepts a loopback override', () => {
    expect(loadConfig().semanticApiUrl.toString()).toBe('http://127.0.0.1:3876/bridge/');
    const config = loadConfig({ SP_SEMANTIC_API_URL: 'http://127.0.0.1:3877/bridge/' });
    expect(config.semanticApiUrl.toString()).toBe('http://127.0.0.1:3877/bridge/');
    expect(() => loadConfig({ SP_SEMANTIC_API_URL: 'http://example.com:3877' })).toThrow(AppError);
  });

  it('rejects credentials and query parameters in the API URL', () => {
    expect(() => loadConfig({ SP_API_URL: 'http://user:pass@127.0.0.1:3876' })).toThrow(
      'must not contain credentials',
    );
    expect(() => loadConfig({ SP_API_URL: 'http://127.0.0.1:3876/?token=secret' })).toThrow(
      'must not contain credentials',
    );
  });
});
