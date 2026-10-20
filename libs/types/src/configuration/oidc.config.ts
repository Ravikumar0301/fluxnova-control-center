export interface OIDCConfig {
  authority?: string;
  authorizationURL?: string;
  knownAuthorities?: string[];
  callbackURL: string;
  clientId?: string;
  clientSecret?: string;
  clientAuthMethod?: 'client_secret' | 'private_key_jwt';
  clientPrivateKey?: string;
  clientPrivateKeyJwtAlgorithm?: 'RS256';
  issuer?: string;
  scopes: string[];
  tokenURL?: string;
  userInfoURL?: string;
}
