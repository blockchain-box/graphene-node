import { Interface, parseEther, isAddress } from 'ethers';
import { tendermintValidatorAddress } from '../agents/lib/node-setup.js';
import { isEncryptionPublicKey } from '../agents/lib/connection-keys.js';
export const CONTRACT = '0x0000000000000000000000000000000000000004';
const signatures = [
 'function registerValidator(address,string,string,string,string,uint256)',
 'function registerSentry(address,string,string,uint256,string,string,string,uint256)',
 'function updateSentryHost(string,string,uint256)',
 'function applyToSentry(address)', 'function approveApplication(uint256)',
 'function rejectApplication(uint256)', 'function cancelApplication(uint256)', 'function revokeAssignment(uint256)',
 'function delegateStake(address,uint256)', 'function unDelegateStake(address,uint256)',
 'function claimStakeRewards(address)', 'function removeValidator(address)', 'function unlockStake()',
];
const abi = new Interface(signatures);
export function prepareWalletAction(setup, wallet, action, input = {}) {
 if (!isAddress(wallet)) throw new Error('Connect your wallet first.');
 const amount = () => {
  if (typeof input.amount !== 'string' || !/^\d+(\.\d{1,18})?$/.test(input.amount)) throw new Error('Enter a positive GRPH amount with up to 18 decimal places.');
  const value = parseEther(input.amount);
  if (value <= 0n) throw new Error('Enter an amount greater than zero.');
  return value;
 };
 const id = () => {
  const raw = typeof input.id === 'string' || typeof input.id === 'bigint' ? String(input.id)
   : Number.isSafeInteger(input.id) ? String(input.id) : '';
  // State API IDs use hex quantities; form and older API IDs can be decimal.
  if (!/^(?:\d{1,78}|0x[0-9a-f]{1,64})$/i.test(raw)) throw new Error('Choose a valid request or assignment.');
  const value = BigInt(raw);
  if (value >= (1n << 256n)) throw new Error('Choose a valid request or assignment.');
  return value;
 };
 let args, label;
 switch (action) {
  case 'fundAgent':
   if(!isAddress(setup.agentAddress))throw new Error('This node has no valid agent funding address.');
   if(wallet.toLowerCase()===setup.agentAddress.toLowerCase())throw new Error('This wallet is already the agent account. Top it up from another wallet using its Send screen.');
   return {label:`Fund ${setup.name} agent with ${input.amount} GRPH`,chainId:'0x2694',wallet,node:setup.name,agentAddress:setup.agentAddress,funding:true,transaction:{from:wallet,to:setup.agentAddress,data:'0x',value:'0x'+amount().toString(16)}};
  case 'registerValidator':
   if (setup.role !== 'validator') throw new Error('Choose a validator node.');
   args = [setup.agentAddress, setup.nodeId, setup.consensusPublicKey, setup.encryptionPublicKey, setup.name, amount()]; label = `Register ${setup.name} with ${input.amount} GRPH stake`; break;
  case 'registerSentry': {
   if (setup.role !== 'sentry') throw new Error('Choose a sentry node.');
   if (!/^[A-Za-z]{2}$/.test(input.country || '') || !/^\d{1,3}$/.test(String(input.capacity)) || Number(input.capacity) < 1 || Number(input.capacity) > 999) throw new Error('Enter a two-letter country code and a validator capacity between 1 and 999.');
   args = [setup.agentAddress, setup.name, input.country.toUpperCase(), BigInt(input.capacity), setup.encryptionPublicKey, setup.nodeId, setup.p2pHost, setup.p2pPort]; label = `Register sentry ${setup.name}`; break;
  }
  case 'updateSentryHost':
   if (setup.role !== 'sentry' || wallet.toLowerCase() !== setup.agentAddress.toLowerCase()) throw new Error('This chain can update an address only when the owner wallet is also the sentry ID. Ask your provider for this sentry’s address migration.');
   if (typeof input.host !== 'string' || !input.host || input.host.length > 253 || /[\s/@]/.test(input.host) || !Number.isInteger(Number(input.port)) || Number(input.port) < 1 || Number(input.port) > 65535) throw new Error('Enter a reachable hostname and a port between 1 and 65535.');
   args = [setup.nodeId, input.host, Number(input.port)]; label = `Update sentry address to ${input.host}:${input.port}`; break;
  case 'applyToSentry':
   if (setup.role !== 'validator' || !isAddress(input.sentryId)) throw new Error('Choose a sentry for this validator.');
   args = [input.sentryId]; label = `Request a connection to ${input.sentryId}`; break;
  case 'approveApplication': case 'rejectApplication':
   if (setup.role !== 'sentry') throw new Error('Choose the sentry receiving this request.');
   args = [id()]; label = `${action === 'approveApplication' ? 'Approve' : 'Decline'} request #${input.id}`; break;
  case 'cancelApplication': case 'revokeAssignment':
   if (action === 'cancelApplication' && setup.role !== 'validator') throw new Error('Choose the requesting validator.');
   args = [id()]; label = `${action === 'cancelApplication' ? 'Cancel request' : 'Revoke connection'} #${input.id}`; break;
  case 'delegateStake': case 'unDelegateStake':
   if (setup.role !== 'validator') throw new Error('Choose a validator node.');
   args = [wallet, amount()]; label = `${action === 'delegateStake' ? 'Stake' : 'Unstake'} ${input.amount} GRPH`; break;
  case 'claimStakeRewards': case 'removeValidator':
   if (setup.role !== 'validator') throw new Error('Choose a validator node.');
   args = [wallet]; label = action === 'claimStakeRewards' ? 'Claim staking rewards' : 'Request validator exit · keep the node running until removal is confirmed'; break;
  case 'unlockStake':
   if (setup.role !== 'validator') throw new Error('Choose a validator node.');
   args = []; label = 'Withdraw validator self-stake after unbonding'; break;
  default: throw new Error('This wallet action is not supported.');
 }
 return { label, chainId: '0x2694', wallet, node: setup.name, agentAddress: setup.agentAddress, transaction: { from: wallet, to: CONTRACT, data: abi.encodeFunctionData(action, args), value: '0x0' } };
}
export async function chainJson(route, options) {
 const response = await fetch('http://127.0.0.1:3003/graphene-evm' + route, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' }).catch(() => { throw new Error('The Graphene network is unavailable on this host. Check the provider’s local stack.'); });
 if (response.status === 404 || response.status === 204) return null;
 if (!response.ok) throw new Error('The Graphene network is unavailable on this node host. Check the provider’s local stack.');
 if(route.startsWith('/graphene/state/stake/validator/reward?')){const raw=(await response.text()).trim();const value=raw.startsWith('"')?JSON.parse(raw):raw;if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('The network returned an unreadable validator reward.');return value;}
 if(route.startsWith('/graphene/state/stake/validators?'))return JSON.parse(await response.text(),(key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?\d+$/.test(context.source)?context.source:value);
 return response.json();
}

// Registrations are public chain state. Discovery never creates a local identity.
export async function walletNodes(wallet, read = chainJson) {
 if (!isAddress(wallet)) throw new Error('Enter a valid wallet address.');
 wallet = wallet.toLowerCase();
 const [validator, sentries] = await Promise.all([
  read('/graphene/state/platform/validators/' + wallet),
  read('/graphene/state/platform/sentries?operator=' + wallet),
 ]);
 if (sentries !== null && !Array.isArray(sentries)) throw new Error('The network returned an invalid sentry list. Try again.');
 const records = [];
 if (validator?.registered && validator.wallet?.toLowerCase() === wallet) records.push({ role: 'validator', record: validator });
 for (const record of sentries || []) if (record.operator?.toLowerCase() === wallet) records.push({ role: 'sentry', record });
 const seen = new Set();
 const nodes = records.map(({ role, record }) => {
  const agentAddress = role === 'sentry' ? record.sentryId : record.agentAddress;
  if (!isAddress(agentAddress)) throw new Error('A registered node has an invalid agent address. Ask your provider to check the network data.');
  const id = role + '-' + agentAddress.toLowerCase();
  const setup = {
   version: 1, role, name: record.name || record.moniker || (role === 'sentry' ? 'Registered sentry' : 'Registered validator'),
   agentAddress, nodeId: record.nodeId || record.tendermintNodeId,
   encryptionPublicKey: String(record.encryptionPublicKey || '').replace(/^0x/, ''),
   ...(role === 'validator' ? { consensusPublicKey: record.networkPublicKey, tendermintValidatorAddress:tendermintValidatorAddress(record.networkPublicKey) } : { p2pHost: record.p2pHost, p2pPort: Number(record.p2pPort) }),
  };
  // Explicit fields prevent the discovery response becoming a general chain-data export.
  return { id, role, name: setup.name, setup, ownerWallet: wallet, chainOnly: true, unlocked: false, status: { state: 'not-linked' }, active: role === 'validator' ? record.registered : record.active };
 }).filter(node => { if (seen.has(node.id)) return false; seen.add(node.id); return true; });
 return { wallet, nodes };
}

export async function nodeChainState(setup, wallet, read = chainJson) {
 if (!isAddress(wallet)) throw new Error('Connect your wallet to check registration and requests.');
 const query = setup.role === 'sentry' ? 'sentryId=' + setup.agentAddress.toLowerCase() : 'validator=' + wallet.toLowerCase();
 const [registration, sentries, applications, assignments, validators, sync, funding, rewards] = await Promise.all([
  setup.role === 'validator' ? read('/graphene/state/platform/validators/' + wallet.toLowerCase()) : Promise.resolve(null),
  read('/graphene/state/platform/sentries'), read('/graphene/state/platform/applications?' + query), read('/graphene/state/platform/assignments?' + query),
  setup.role === 'validator' ? read('/graphene/state/stake/validators?chainId=9876') : Promise.resolve(null),
  setup.role === 'validator' ? read('/graphene/state/sync-status') : Promise.resolve(null),
  readAgentFunding(setup,read),
  setup.role==='validator'?readValidatorRewards(wallet,read):Promise.resolve(null),
 ]);
 const record = setup.role === 'sentry' ? (sentries || []).find(s => s.sentryId?.toLowerCase() === setup.agentAddress.toLowerCase()) || null : registration;
 const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
 const identityMatches = !!record && same(record.agentAddress || record.sentryId, setup.agentAddress)
  && same(record.nodeId || record.tendermintNodeId, setup.nodeId)
  && same(String(record.encryptionPublicKey || '').replace(/^0x/, ''), setup.encryptionPublicKey)
  && (setup.role !== 'validator' || record.networkPublicKey === setup.consensusPublicKey);
 const endpointMatches = setup.role !== 'sentry' || !!record && record.p2pHost === setup.p2pHost && Number(record.p2pPort) === setup.p2pPort;
 const ownerMatches = identityMatches && (record.wallet || record.operator)?.toLowerCase() === wallet.toLowerCase();
 const staking = Array.isArray(validators) ? validators.find(v => same(typeof v.address === 'string' ? v.address : (v.address?.address || v.address?.value), wallet)) || null : null;
 const exit = validatorExitStatus(staking, sync?.lastStateSyncedBlock);
 return { staking, exit, downtime:validatorDowntimeImpact(staking), rewards:ownerMatches?rewards:null, registration: record, identityMatches, endpointMatches, ownerMatches, agentFunding:funding, sentries: (sentries || []).map(s=>({...s,encryptionKeyValid:isEncryptionPublicKey(s.encryptionPublicKey)})), applications: applications || [], assignments: assignments || [] };
}

// These heights are committed State Sync progress, never local clock time or transaction submission.
export function validatorExitStatus(staking, committedHeight) {
 const height = value => (typeof value !== 'number' || Number.isSafeInteger(value)) && /^(0|[1-9]\d*)$/.test(String(value)) ? BigInt(value) : null;
 const requested = height(staking?.exitRequestedHeight);
 const effective = height(staking?.exitEffectiveHeight);
 const withdrawable = height(staking?.withdrawableHeight);
 const committed = height(committedHeight);
 if (requested === null) return { requested: false, safeToStop: false, canWithdraw: false };
 const valid = requested > 0n && effective !== null && effective >= requested + 2n
  && withdrawable !== null && withdrawable > effective;
 const safeToStop = valid && committed !== null && committed >= effective;
 return { requested: true, safeToStop, canWithdraw: safeToStop && committed >= withdrawable,
  effectiveHeight: effective?.toString(), withdrawableHeight: withdrawable?.toString() };
}

// Reads only. The owner wallet signs a separate native transfer after review.
export async function readAgentFunding(setup,read=chainJson) {
 const address=setup.agentAddress;
 const rpc=async method=>{const result=await read('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'agent-funding',method,params:method==='eth_getBalance'?[address,'latest']:[]})});if(result?.error||typeof result?.result!=='string'||!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(result.result))throw new Error('Agent balance or network fee could not be verified.');return BigInt(result.result);};
 try {const [balance,gasPrice]=await Promise.all([rpc('eth_getBalance'),rpc('eth_gasPrice')]);return {address,balanceWei:balance.toString(),gasPriceWei:gasPrice.toString(),status:setup.role==='sentry'?'not-required':gasPrice===0n?'free':balance===0n?'empty':'funded'};}
 catch(error){return {address,status:setup.role==='sentry'?'not-required':'unavailable',error:error.message};}
}

export async function readValidatorRewards(wallet,read=chainJson){
 try{const raw=await read('/graphene/state/stake/validator/reward?chainId=9876&validatorAddress='+wallet.toLowerCase());const value=typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>=0?String(raw):raw;if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('Validator rewards could not be read without losing precision.');return {status:'ready',pendingWei:value};}
 catch(error){return {status:'unavailable',error:error.message};}
}


// Mirrors OnBeginBlockHandler.handleDowntime and DiscreteStakingRewards.
// This is a projection in missed consensus votes, not a promised GRPH loss.
export function validatorDowntimeImpact(staking) {
 const integer=value=>typeof value==='string'&&/^\d+$/.test(value)?BigInt(value):typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
 if(!staking)return {status:'unavailable'};
 if(staking.exitRequestedHeight!==null&&staking.exitRequestedHeight!==undefined)return {status:'exiting',stakeSlashWei:'0'};
 const signed=integer(staking.signedBlocks),window=integer(staking.windowBlocks),score=integer(staking.participationScore),self=integer(staking.selfStake),delegated=integer(staking.totalDelegatorStake),weight=integer(staking.effectiveWeight),scale=10n**18n;
 if([signed,window,score,self,delegated,weight].some(value=>value===null)||signed>window||score>scale)return {status:'unavailable'};
 if(window===0n&&score===0n&&self+delegated>0n)return {status:'awaiting-signature',stakeSlashWei:'0'};
 return {status:'ready',stakeSlashWei:'0',score:score.toString(),signedBlocks:signed.toString(),observedBlocks:window.toString(),missedBlocks:(window-signed).toString(),effectiveWeightWei:weight.toString(),projections:[1n,10n,100n].map(missed=>{
  const nextScore=signed*scale/(window+missed),nextWeight=(self+delegated)*nextScore/scale;
  return {missedBlocks:missed.toString(),score:nextScore.toString(),effectiveWeightWei:nextWeight.toString(),weightReductionWei:(weight>nextWeight?weight-nextWeight:0n).toString()};
 })};
}
