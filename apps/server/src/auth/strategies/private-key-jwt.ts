import { sign as signJwt } from 'jsonwebtoken';
import { generateUuidV4 } from '../../common';

type ClientAssertionContext = {
  clientId: string;
  tokenEndpoint?: string;
};

type PrivateKeyJwtOptions = {
  algorithm: 'RS256';
  privateKey: string;
};

export function createPrivateKeyJwtAssertion(options: PrivateKeyJwtOptions) {
  return async ({ clientId, tokenEndpoint }: ClientAssertionContext): Promise<string> => {
    if (!options.privateKey || !tokenEndpoint) {
      throw new Error('FXN_OIDC_PRIVATE_KEY and the OIDC token endpoint are required for private_key_jwt');
    }

    const issuedAt = Math.floor(Date.now() / 1000);

    return signJwt({ iat: issuedAt }, options.privateKey, {
      algorithm: options.algorithm,
      issuer: clientId,
      subject: clientId,
      audience: tokenEndpoint,
      expiresIn: 60,
      jwtid: generateUuidV4(),
    });
  };
}
