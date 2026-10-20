import { isEmpty } from 'lodash-es';
import { AuthStrategy } from '../auth/strategies/strategies.enum';
import { createPrivateKey } from 'crypto';

const validator = (env: Record<string, any>, requiredVars: string[], conditionMessage: string) => {
  const unsetVars: string[] = requiredVars.filter((envVar: string) => isEmpty(env[envVar]));

  if (unsetVars.length) {
    throw new Error(
      `${conditionMessage} but ${unsetVars.length < 2 ? unsetVars[0] : unsetVars.join(', ')} ${unsetVars.length > 1 ? 'are' : 'is'} missing. Ensure these env variables are properly configured.`,
    );
  }
};

const normalizePrivateKey = (privateKey: string): string => privateKey.replace(/\r\n/g, '\n').replace(/\\n/g, '\n');

export const validate = (env: Record<string, any>) => {
  // Validate that if oidc auth is enabled, all required env vars are set
  if (env.FXN_AUTH_STRATEGY === AuthStrategy.oidc) {
    const requiredVars = [
      'FXN_OIDC_AUTHORITY',
      'FXN_OIDC_AUTH_URL',
      'FXN_OIDC_CLIENT_ID',
      'FXN_OIDC_ISSUER',
      'FXN_OIDC_TOKEN_URL',
      'FXN_OIDC_USERINFO_URL',
    ];

    validator(env, requiredVars, 'OIDC Authentication is enabled');

    const clientAuthMethod = env.FXN_OIDC_CLIENT_AUTH_METHOD ?? 'client_secret';

    if (clientAuthMethod !== 'client_secret' && clientAuthMethod !== 'private_key_jwt') {
      throw new Error('FXN_OIDC_CLIENT_AUTH_METHOD must be "client_secret" or "private_key_jwt".');
    }

    if (clientAuthMethod === 'client_secret') {
      validator(env, ['FXN_OIDC_CLIENT_SECRET'], 'OIDC client_secret authentication is enabled');
    } else {
      validator(env, ['FXN_OIDC_PRIVATE_KEY'], 'OIDC private_key_jwt authentication is enabled');

      const algorithm = env.FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM ?? 'RS256';
      if (algorithm !== 'RS256') {
        throw new Error('FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM must be RS256; the configured algorithm is unsupported.');
      }

      let privateKey;
      try {
        privateKey = createPrivateKey(normalizePrivateKey(env.FXN_OIDC_PRIVATE_KEY));
      } catch {
        throw new Error('FXN_OIDC_PRIVATE_KEY must contain a valid PEM-encoded RSA private key.');
      }

      if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new Error('FXN_OIDC_PRIVATE_KEY must contain an RSA private key with at least a 2048-bit modulus.');
      }
    }
  }

  // Validate that if api auth is enabled, all required env vars are set
  if (env.FXN_API_AUTH_ENABLED === 'true') {
    const requiredVars = ['FXN_API_AUTH_CLIENT_ID', 'FXN_API_AUTH_CLIENT_SECRET', 'FXN_API_AUTH_TOKEN_URL'];

    validator(env, requiredVars, 'API Authentication is enabled');
  }

  // Validate that when deployed to an environment CSRF key is set
  if (!isEmpty(env.FXN_PUBLIC_URL) && !env.FXN_PUBLIC_URL.includes('localhost'))
    validator(env, ['FXN_CSRF_KEY'], 'Application is not running locally');

  return env;
};
