import crypto from 'crypto';
// @ts-ignore
import ece from 'http_ece';

interface DecryptObject {
  appData: Array<{ key: string; value: string }>;
  rawData: Buffer;
}

interface DecryptKeys {
  privateKey: string;
  authSecret: string;
}

// https://tools.ietf.org/html/draft-ietf-webpush-encryption-03
export function decrypt(object: DecryptObject, keys: DecryptKeys): any {
  const cryptoKey = object.appData.find((item) => item.key === 'crypto-key');
  if (!cryptoKey) throw new Error('crypto-key is missing');

  const salt = object.appData.find((item) => item.key === 'encryption');
  if (!salt) throw new Error('salt is missing');

  const remoteKey = getParameter(cryptoKey.value, 'dh');
  if (!remoteKey) throw new Error('crypto-key is missing dh');
  const saltValue = getParameter(salt.value, 'salt');
  if (!saltValue) throw new Error('salt is missing');

  const dh = crypto.createECDH('prime256v1');
  dh.setPrivateKey(keys.privateKey, 'base64');

  const params = {
    version: 'aesgcm',
    authSecret: keys.authSecret,
    dh: remoteKey,
    privateKey: dh,
    salt: saltValue,
  };
  const decrypted = ece.decrypt(object.rawData, params);

  return JSON.parse(decrypted.toString());
}

function getParameter(header: string, name: string): string | undefined {
  const parameter = header
    .split(/[;,]/)
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return parameter?.slice(name.length + 1).replace(/^"|"$/g, '');
}
