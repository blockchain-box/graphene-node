import { generate } from '@grph-net/utils';
import { randomBytes } from './utils.js';
import nacl from 'tweetnacl';
import { ethers } from 'ethers';
import crypto from 'crypto';

export function generateSeed() {
  return randomBytes(32);
}

export function generateGrphKeys(seed) {
  const result = generate(seed);
  return {
    seed: result.seed.toString('hex'),
    keyPair: {
      publicKey: result.keyPair.publicKey.toString('hex'),
      secretKey: result.keyPair.secretKey.toString('hex'),
    },
    hmac: result.hmac.toString('hex'),
    capability: result.capability.toString('hex'),
    invite: result.invite,
  };
}

export function generateX25519Keypair() {
  const pair = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey).toString('hex'),
    secretKey: Buffer.from(pair.secretKey).toString('hex'),
  };
}

export function generateAgentEthKey() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase || null,
  };
}

export function generateTendermintValidatorKey() {
  const pair = nacl.sign.keyPair();
  const address = crypto.createHash('ripemd160')
    .update(crypto.createHash('sha256').update(Buffer.from(pair.publicKey)).digest())
    .digest()
    .slice(0, 20);

  return {
    publicKey: {
      type: 'tendermint/PubKeyEd25519',
      value: Buffer.from(pair.publicKey).toString('base64'),
    },
    privateKey: {
      type: 'tendermint/PrivKeyEd25519',
      value: Buffer.from(pair.secretKey).toString('base64'),
    },
    address: address.toString('hex').toUpperCase(),
  };
}

export function generateTendermintNodeKey() {
  const pair = nacl.sign.keyPair();
  const nodeId = crypto.createHash('sha256')
    .update(Buffer.from(pair.publicKey))
    .digest()
    .slice(0, 20);

  return {
    publicKey: {
      type: 'tendermint/PubKeyEd25519',
      value: Buffer.from(pair.publicKey).toString('base64'),
    },
    privateKey: {
      type: 'tendermint/PrivKeyEd25519',
      value: Buffer.from(pair.secretKey).toString('base64'),
    },
    nodeId: nodeId.toString('hex'),
  };
}

export function generateAll() {
  const seed = generateSeed();
  const grph = generateGrphKeys(seed);
  const x25519 = generateX25519Keypair();
  const agent = generateAgentEthKey();
  const validator = generateTendermintValidatorKey();
  const node = generateTendermintNodeKey();

  return {
    grph,
    x25519,
    agent,
    tendermint: {
      validator,
      node,
    },
  };
}
