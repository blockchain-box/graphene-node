// Registry encryption keys are X25519 public keys, encoded as 32-byte hex.
export function isEncryptionPublicKey(value) {
 return typeof value==='string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value);
}
export function decodeSentryEncryptionKey(value) {
 if(!isEncryptionPublicKey(value))throw new Error('The registered sentry encryption key must be 32 bytes (64 hexadecimal characters). Ask its owner to correct the registration, or choose another sentry. Unlocking or funding the node does not repair this key.');
 return Buffer.from(value.replace(/^0x/i,''),'hex');
}
