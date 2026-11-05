import crypto from 'crypto';
// @ts-ignore
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import { decrypt } from './core/utils/decrypt';
import { DEFAULT_VAPID_KEY } from './core/fcm/server-key';

describe('Google Web Push payload decryption', () => {
  it.each(['dh-first', 'signing-key-first', 'quoted-parameters'])(
    'decrypts payloads with %s crypto-key parameters',
    (layout) => {
      const receiver = crypto.createECDH('prime256v1');
      receiver.generateKeys();
      const sender = crypto.createECDH('prime256v1');
      sender.generateKeys();
      const auth = crypto.randomBytes(16);
      const salt = crypto.randomBytes(16);
      const payload = { data: { validationId: 'test-notification' } };
      const rawData = ece.encrypt(Buffer.from(JSON.stringify(payload)), {
        version: 'aesgcm',
        privateKey: sender,
        dh: receiver.getPublicKey(),
        authSecret: auth,
        salt,
      });
      const remoteKey = sender.getPublicKey('base64');
      const cryptoKey =
        layout === 'dh-first'
          ? `dh=${remoteKey};p256ecdsa=${DEFAULT_VAPID_KEY}`
          : layout === 'signing-key-first'
            ? `p256ecdsa=${DEFAULT_VAPID_KEY}; dh=${remoteKey}`
            : `p256ecdsa="${DEFAULT_VAPID_KEY}"; dh="${remoteKey}"`;
      const appData = [
        { key: 'crypto-key', value: cryptoKey },
        { key: 'encryption', value: `keyid=test; salt="${salt.toString('base64')}";rs=4096` },
      ];

      expect(
        decrypt(
          { appData, rawData },
          {
            privateKey: receiver.getPrivateKey('base64'),
            authSecret: auth.toString('base64'),
          },
        ),
      ).toEqual(payload);
    },
  );

  it('rejects a header without a decryption key without treating its signing key as dh', () => {
    expect(() =>
      decrypt(
        {
          appData: [
            { key: 'crypto-key', value: `p256ecdsa=${DEFAULT_VAPID_KEY}` },
            { key: 'encryption', value: 'salt=test' },
          ],
          rawData: Buffer.alloc(0),
        },
        { privateKey: 'unused', authSecret: 'unused' },
      ),
    ).toThrow('crypto-key is missing dh');
  });
});
