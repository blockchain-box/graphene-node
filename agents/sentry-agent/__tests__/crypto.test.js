import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { fromHex, toHex } from '../src/utils.js';

describe('X25519 invite key decryption round-trip', () => {
  const INVITE_KEY = 'grph_1bkkmzkqnz41f8mns11bffppcecyb3pggyyuk8six8m8nsuyrg66ncqfm74q1m1bu41';

  function sealInviteKey(inviteKey, sentryX25519PublicKey) {
    const sentryPub = fromHex(sentryX25519PublicKey);
    const message = typeof inviteKey === 'string' ? inviteKey : toHex(inviteKey);

    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const messageBytes = naclUtil.decodeUTF8(message);

    const sealed = nacl.box(messageBytes, nonce, sentryPub, ephemeralKeyPair.secretKey);

    const payload = Buffer.concat([
      Buffer.from(ephemeralKeyPair.publicKey),
      nonce,
      Buffer.from(sealed),
    ]);

    return toHex(payload);
  }

  function openInviteKey(encryptedConnectionString, x25519SecretKeyHex) {
    const data = fromHex(encryptedConnectionString);
    const pubKeyLen = 32;
    const nonceLen = nacl.box.nonceLength;

    const ephemeralPub = data.subarray(0, pubKeyLen);
    const nonce = data.subarray(pubKeyLen, pubKeyLen + nonceLen);
    const sealed = data.subarray(pubKeyLen + nonceLen);

    const secretKey = fromHex(x25519SecretKeyHex);
    const decrypted = nacl.box.open(sealed, nonce, ephemeralPub, secretKey);

    if (!decrypted) throw new Error('Decryption failed');
    return naclUtil.encodeUTF8(decrypted);
  }

  it('seals and opens a grph invite key with X25519', () => {
    const sentryKeyPair = nacl.box.keyPair();
    const sentryPub = Buffer.from(sentryKeyPair.publicKey).toString('hex');
    const sentrySec = Buffer.from(sentryKeyPair.secretKey).toString('hex');

    const encrypted = sealInviteKey(INVITE_KEY, sentryPub);

    expect(encrypted).toMatch(/^0x[a-f0-9]+$/);

    const decrypted = openInviteKey(encrypted, sentrySec);
    expect(decrypted).toBe(INVITE_KEY);
  });

  it('fails with wrong secret key', () => {
    const sentryKeyPair = nacl.box.keyPair();
    const otherKeyPair = nacl.box.keyPair();
    const sentryPub = Buffer.from(sentryKeyPair.publicKey).toString('hex');
    const otherSec = Buffer.from(otherKeyPair.secretKey).toString('hex');

    const encrypted = sealInviteKey(INVITE_KEY, sentryPub);

    expect(() => openInviteKey(encrypted, otherSec)).toThrow('Decryption failed');
  });

  it('fails with corrupted payload', () => {
    const sentryKeyPair = nacl.box.keyPair();
    const sentryPub = Buffer.from(sentryKeyPair.publicKey).toString('hex');
    const sentrySec = Buffer.from(sentryKeyPair.secretKey).toString('hex');

    const encrypted = sealInviteKey(INVITE_KEY, sentryPub);
    const corrupted = '0x' + encrypted.slice(2, -4) + 'dead';

    expect(() => openInviteKey(corrupted, sentrySec)).toThrow();
  });
});
