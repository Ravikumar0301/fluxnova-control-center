/* eslint-disable n/no-process-env -- This runs before the config service is initialized so we have to use process.env */

import { OIDCConfig } from '@fxn/types';
import { registerAs } from '@nestjs/config';
import { FLUXNOVA_PORT } from '../';

export const oidcConfigFactory = async (): Promise<OIDCConfig> => {
  let knownAuthorities: string[] = [];
  if (process.env.FXN_OIDC_KNOWN_AUTHORITIES) {
    knownAuthorities = process.env.FXN_OIDC_KNOWN_AUTHORITIES.split(',');
  } else if (process.env.FXN_OIDC_AUTHORITY) {
    knownAuthorities = [process.env.FXN_OIDC_AUTHORITY];
  }

  return {
    authority: process.env.FXN_OIDC_AUTHORITY,
    authorizationURL: process.env.FXN_OIDC_AUTH_URL,
    callbackURL:
      process.env.FXN_PUBLIC_URL?.concat('/api/callback') ?? `http://localhost:${FLUXNOVA_PORT}/api/callback`,
    clientId: process.env.FXN_OIDC_CLIENT_ID, //pragma: allowlist-secret not secret
    clientSecret: process.env.FXN_OIDC_CLIENT_SECRET, //pragma: allowlist-secret not secret
    clientAuthMethod: (process.env.FXN_OIDC_CLIENT_AUTH_METHOD ?? 'client_secret') as OIDCConfig['clientAuthMethod'],
    clientPrivateKey: process.env.FXN_OIDC_PRIVATE_KEY?.replace(/\r\n/g, '\n').replace(/\\n/g, '\n'),
    clientPrivateKeyJwtAlgorithm: (process.env.FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM ??
      'RS256') as OIDCConfig['clientPrivateKeyJwtAlgorithm'],
    issuer: process.env.FXN_OIDC_ISSUER,
    knownAuthorities,
    scopes: process.env.FXN_OIDC_SCOPE?.split(',') ?? ['openid', 'profile', 'email', 'offline_access'],
    tokenURL: process.env.FXN_OIDC_TOKEN_URL,
    userInfoURL: process.env.FXN_OIDC_USERINFO_URL,
  };
};

export default registerAs('oidc', oidcConfigFactory);
