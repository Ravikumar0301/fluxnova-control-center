import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { AuthStrategy } from '../auth/strategies/strategies.enum';
import { validate } from './validator';

const createPrivateKeyJwtEnv = (overrides: Record<string, string> = {}) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return {
    FXN_AUTH_STRATEGY: AuthStrategy.oidc,
    FXN_OIDC_AUTHORITY: 'authority',
    FXN_OIDC_AUTH_URL: 'url',
    FXN_OIDC_CLIENT_ID: 'id',
    FXN_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
    FXN_OIDC_PRIVATE_KEY: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    FXN_OIDC_ISSUER: 'issuer',
    FXN_OIDC_TOKEN_URL: 'token',
    FXN_OIDC_USERINFO_URL: 'userinfo',
    ...overrides,
  };
};

describe('validate', () => {
  it('throws error if OIDC auth is enabled and required vars are missing', () => {
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.oidc,
    };

    expect(() => validate(env)).toThrow(
      /OIDC Authentication is enabled but FXN_OIDC_AUTHORITY, FXN_OIDC_AUTH_URL, FXN_OIDC_CLIENT_ID, FXN_OIDC_ISSUER, FXN_OIDC_TOKEN_URL, FXN_OIDC_USERINFO_URL are missing/,
    );
  });

  it('does not throw if OIDC auth is enabled and all vars are set', () => {
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.oidc,
      FXN_OIDC_AUTHORITY: 'authority',
      FXN_OIDC_AUTH_URL: 'url',
      FXN_OIDC_CLIENT_ID: 'id',
      FXN_OIDC_CLIENT_SECRET: 'secret',
      FXN_OIDC_ISSUER: 'issuer',
      FXN_OIDC_TOKEN_URL: 'token',
      FXN_OIDC_USERINFO_URL: 'userinfo',
    };

    expect(() => validate(env)).not.toThrow();
  });

  it('accepts private_key_jwt without a client secret and defaults the algorithm to RS256', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.oidc,
      FXN_OIDC_AUTHORITY: 'authority',
      FXN_OIDC_AUTH_URL: 'url',
      FXN_OIDC_CLIENT_ID: 'id',
      FXN_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
      FXN_OIDC_PRIVATE_KEY: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      FXN_OIDC_ISSUER: 'issuer',
      FXN_OIDC_TOKEN_URL: 'token',
      FXN_OIDC_USERINFO_URL: 'userinfo',
    };

    expect(() => validate(env)).not.toThrow();
  });

  it('accepts an explicitly configured RS256 algorithm for private_key_jwt', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.oidc,
      FXN_OIDC_AUTHORITY: 'authority',
      FXN_OIDC_AUTH_URL: 'url',
      FXN_OIDC_CLIENT_ID: 'id',
      FXN_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
      FXN_OIDC_PRIVATE_KEY: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM: 'RS256',
      FXN_OIDC_ISSUER: 'issuer',
      FXN_OIDC_TOKEN_URL: 'token',
      FXN_OIDC_USERINFO_URL: 'userinfo',
    };

    expect(() => validate(env)).not.toThrow();
  });

  it('requires the client ID for private_key_jwt', () => {
    const env = createPrivateKeyJwtEnv({ FXN_OIDC_CLIENT_ID: '' });

    expect(() => validate(env)).toThrow(/FXN_OIDC_CLIENT_ID is missing/);
  });

  it('requires a private key for private_key_jwt', () => {
    const env = createPrivateKeyJwtEnv({ FXN_OIDC_PRIVATE_KEY: '' });

    expect(() => validate(env)).toThrow(/FXN_OIDC_PRIVATE_KEY is missing/);
  });

  it('rejects an unsupported client authentication method', () => {
    const env = createPrivateKeyJwtEnv({ FXN_OIDC_CLIENT_AUTH_METHOD: 'client_assertion' });

    expect(() => validate(env)).toThrow('FXN_OIDC_CLIENT_AUTH_METHOD must be "client_secret" or "private_key_jwt".');
  });

  it('rejects a malformed private key without exposing its contents', () => {
    const env = createPrivateKeyJwtEnv({ FXN_OIDC_PRIVATE_KEY: 'do-not-expose-this-invalid-key' });

    let error: unknown;
    try {
      validate(env);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('FXN_OIDC_PRIVATE_KEY must contain a valid PEM-encoded RSA private key.');
    expect((error as Error).message).not.toContain('do-not-expose-this-invalid-key');
  });

  it('rejects a non-RSA private key for RS256', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const env = createPrivateKeyJwtEnv({
      FXN_OIDC_PRIVATE_KEY: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    });

    expect(() => validate(env)).toThrow(
      'FXN_OIDC_PRIVATE_KEY must contain an RSA private key with at least a 2048-bit modulus.',
    );
  });

  it('rejects unsupported signing algorithms without falling back', () => {
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.oidc,
      FXN_OIDC_AUTHORITY: 'authority',
      FXN_OIDC_AUTH_URL: 'url',
      FXN_OIDC_CLIENT_ID: 'id',
      FXN_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
      FXN_OIDC_PRIVATE_KEY: 'placeholder-not-a-real-key',
      FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM: 'HS256',
      FXN_OIDC_ISSUER: 'issuer',
      FXN_OIDC_TOKEN_URL: 'token',
      FXN_OIDC_USERINFO_URL: 'userinfo',
    };

    expect(() => validate(env)).toThrow(
      'FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM must be RS256; the configured algorithm is unsupported.',
    );
  });

  it('throws error if API auth is enabled and required vars are missing', () => {
    const env = {
      FXN_API_AUTH_ENABLED: 'true',
      FXN_API_AUTH_CLIENT_ID: '',
      FXN_API_AUTH_CLIENT_SECRET: '',
      FXN_API_AUTH_TOKEN_URL: '',
    };

    expect(() => validate(env)).toThrow(
      /API Authentication is enabled but FXN_API_AUTH_CLIENT_ID, FXN_API_AUTH_CLIENT_SECRET, FXN_API_AUTH_TOKEN_URL are missing/,
    );
  });

  it('does not throw if API auth is enabled and all vars are set', () => {
    const env = {
      FXN_API_AUTH_ENABLED: 'true',
      FXN_API_AUTH_CLIENT_ID: 'id',
      FXN_API_AUTH_CLIENT_SECRET: 'secret',
      FXN_API_AUTH_TOKEN_URL: 'token',
    };

    expect(() => validate(env)).not.toThrow();
  });

  it('does not throw if neither OIDC nor API auth is enabled', () => {
    const env = {};

    expect(() => validate(env)).not.toThrow();
  });

  it('does not require OIDC credentials when the auth strategy is none', () => {
    const env = {
      FXN_AUTH_STRATEGY: AuthStrategy.none,
      FXN_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
    };

    expect(() => validate(env)).not.toThrow();
  });

  it('throws error if not running locally and FXN_CSRF_KEY is missing', async () => {
    const env = {
      FXN_PUBLIC_URL: 'fluxnova.finos.org',
    };
    expect(() => validate(env)).toThrow(/Application is not running locally but FXN_CSRF_KEY is missing/);
  });

  it('does not throw if not running locally and FXN_CSRF_KEY is set', async () => {
    const env = { FXN_PUBLIC_URL: 'fluxnova.finos.org', FXN_CSRF_KEY: 'key' };
    expect(() => validate(env)).not.toThrow();
  });

  it('does not throw if running locally and FXN_CSRF_KEY is missing', async () => {
    let env = {};
    expect(() => validate(env)).not.toThrow();

    env = { FXN_PUBLIC_URL: 'localhost' };
    expect(() => validate(env)).not.toThrow();
  });
});
