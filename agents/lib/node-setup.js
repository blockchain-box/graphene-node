import {createHash} from 'node:crypto';

export function tendermintValidatorAddress(publicKey){
 if(typeof publicKey!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(publicKey))return null;
 const bytes=Buffer.from(publicKey,'base64');if(bytes.length!==32||bytes.toString('base64')!==publicKey)return null;
 return createHash('sha256').update(bytes).digest().subarray(0,20).toString('hex').toUpperCase();
}
export function publicNodeSetup(role, secrets, name, endpoint = {}) {
  const setup = {
    version: 1,
    role,
    name,
    agentAddress: secrets.agent.address,
    encryptionPublicKey: secrets.x25519.publicKey,
  };
  if (role === 'validator') {
    setup.nodeId = secrets.tendermint.node.nodeId;
    setup.consensusPublicKey = secrets.tendermint.validator.publicKey.value;
    setup.tendermintValidatorAddress=tendermintValidatorAddress(setup.consensusPublicKey);
    setup.transportPublicKey = secrets.grph.keyPair.publicKey;
  } else {
    setup.nodeId = secrets.tendermint.node.nodeId;
    setup.p2pHost = endpoint.host;
    setup.p2pPort = endpoint.port;
  }
  const agentRole = role === 'validator'
    ? 'The validator agent watches approved sentry assignments, runs the Grph connection endpoint, and encrypts and publishes connection details using the agent account. It reports connection health. Tendermint signs consensus votes; the agent does not approve applications, control the owner wallet or stake, or prove reward eligibility.'
    : 'The sentry agent watches active assignments, decrypts validator connection details, opens Grph tunnels, and relays Tendermint peer traffic. It verifies peer connections, removes revoked connections, and reports health. The operator wallet approves applications; the agent does not vote on blocks or control validator stake.';
  const descriptions = {
    version: 'Public setup file format version.',
    role: 'Node role: validator participates in consensus; sentry relays validator peer traffic.',
    name: 'Display name for this node.',
    agentAddress: role === 'validator'
      ? 'Dedicated node account used by the agent to publish encrypted connection details. It is separate from the wallet that owns stake; it is not the consensus signing key.'
      : 'Public sentry identity used as sentryId during registration. The registering operator wallet owns the sentry and approves applications.',
    encryptionPublicKey: 'Public X25519 key for encrypted connection details. Its private key stays in the encrypted node identity.',
    nodeId: 'Tendermint peer identity derived from the P2P node key. This is separate from the consensus signing identity.',
    tendermintValidatorAddress: 'Tendermint consensus validator address, derived from the Ed25519 public key. Separate from the owner wallet and P2P peer ID.',
    consensusPublicKey: 'Base64 Ed25519 public key for consensus votes. Tendermint uses the matching private key to sign; keep that key and its signing state on this node only.',
    transportPublicKey: 'Public Grph/DHT transport key for reaching the validator through tunnels. This key is separate from the consensus key.',
    p2pHost: 'Reachable hostname or IP advertised for the sentry Tendermint P2P endpoint.',
    p2pPort: 'Network port advertised for the sentry Tendermint P2P endpoint.',
  };
  return { ...setup, agentRole, fieldDescriptions: Object.fromEntries(Object.keys(setup).map((field) => [field, descriptions[field]])) };
}
