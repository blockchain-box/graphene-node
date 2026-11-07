import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('./node-manager-ui.js', import.meta.url), 'utf8');
const address = '0x' + '1'.repeat(40);
function provider(chain = '0x2694') {
 const result = new EventEmitter();
 result.calls = [];
 result.request = async ({ method }) => {
  result.calls.push(method);
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
  if (method === 'eth_chainId') return chain;
  throw new Error('Unexpected wallet request: ' + method);
 };
 return result;
}
function dashboard(legacy, announced) {
 const elements = new Map();
 const element = id => {
  if (!elements.has(id)) elements.set(id, { value:'', textContent:'', hidden:false, dataset:{}, addEventListener(){}, querySelectorAll(){return [];}, classList:{add(){},remove(){}} });
  return elements.get(id);
 };
 const window = new EventTarget();
 Object.defineProperty(window, 'ethereum', { value:legacy, writable:false });
 const announce = () => {
  const event = new Event('eip6963:announceProvider');
  event.detail = { info:{uuid:'test-wallet',rdns:'io.metamask',name:'MetaMask'}, provider:announced };
  window.dispatchEvent(event);
 };
 if (announced) window.addEventListener('eip6963:requestProvider', announce);
 const context = vm.createContext({ window, document:{ getElementById:element, querySelectorAll:()=>[] }, location:{search:'',hash:'',pathname:'/',port:'8787',origin:'http://127.0.0.1:8787'}, history:{replaceState(){}}, sessionStorage:{getItem(){return null;}}, URLSearchParams, Event, setTimeout, clearTimeout, setInterval(){}, AbortSignal, fetch:()=>new Promise(()=>{}) });
 vm.runInContext(source, context);
 vm.runInContext('useConnectedWallet = () => {};', context);
 return { context, element, run:code=>vm.runInContext(code, context), announce };
}

test('connect uses announced MetaMask when another extension owns read-only window.ethereum', async () => {
 const other = provider();
 other.request = async () => { throw new Error('Other wallet owns window.ethereum'); };
 const metamask = provider();
 const ui = dashboard(other, metamask);
 await ui.run('connectWallet()');
 assert.equal(ui.run('wallet'), address);
 assert.ok(metamask.calls.includes('eth_requestAccounts'));
 assert.equal(ui.element('global-error').textContent, '');
});

test('connecting on another network discovers the account without forcing a network switch, as in explorer', async () => {
 const metamask = provider('0x1');
 const ui = dashboard(metamask);
 await ui.run('connectWallet()');
 assert.equal(ui.run('wallet'), address);
 assert.ok(!metamask.calls.includes('wallet_switchEthereumChain'));
});

test('restoring the session uses announced MetaMask and follows its account and network events', async () => {
 const other = provider(), metamask = provider();
 const ui = dashboard(other, metamask);
 await ui.run('restoreConnectedWallet()');
 assert.equal(ui.run('wallet'), address);
 assert.equal(other.calls.length, 0);
 assert.equal(ui.element('wallet-network').hidden, true);
 metamask.emit('accountsChanged', []);
 assert.equal(ui.run('wallet'), null);
 assert.equal(ui.element('wallet').textContent, 'Connect wallet');
 assert.equal(ui.element('wallet-network').hidden, true);
});

test('explicit network switching adds the host RPC only when the chain is unknown', async () => {
 const metamask = provider('0x1'), calls = [];
 const request = metamask.request;
 metamask.request = async args => {
  calls.push(args);
  if (args.method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Unknown chain'), {code:4902});
  if (args.method === 'wallet_addEthereumChain') return null;
  return request(args);
 };
 const ui = dashboard(metamask);
 await ui.run('connectWallet()');
 assert.equal(ui.element('wallet-network').hidden, false);
 await ui.run('switchWalletNetwork()');
 const add = calls.find(call => call.method === 'wallet_addEthereumChain');
 assert.equal(add.params[0].rpcUrls[0], 'http://127.0.0.1:8787/wallet-rpc/local');
 assert.equal(ui.element('global-error').textContent, '');
});

test('rejecting network switching preserves the connected account', async () => {
 const metamask = provider('0x1'), request = metamask.request;
 metamask.request = args => args.method === 'wallet_switchEthereumChain' ? Promise.reject(Object.assign(new Error('Rejected'), {code:4001})) : request(args);
 const ui = dashboard(metamask);
 await ui.run('connectWallet()');
 await ui.run('switchWalletNetwork()');
 assert.equal(ui.run('wallet'), address);
 assert.match(ui.element('global-error').textContent, /cancelled/);
 assert.equal(ui.element('wallet-network').disabled, false);
});

test('repeated clicks issue only one account request and cancellation allows retry', async () => {
 const metamask = provider();
 let rejectRequest, requests = 0;
 metamask.request = () => { requests++; return new Promise((resolve, reject) => { rejectRequest = reject; }); };
 const ui = dashboard(metamask);
 const pending = ui.run('connectWallet()');
 await ui.run('connectWallet()');
 assert.equal(requests, 1);
 rejectRequest(Object.assign(new Error('Rejected'), {code:4001}));
 await pending;
 assert.equal(ui.element('wallet').disabled, false);
 assert.equal(ui.element('wallet').textContent, 'Connect wallet');
 assert.match(ui.element('global-error').textContent, /cancelled/);
});

test('transaction approval stays on the selected provider when the global belongs to another wallet', async () => {
 const other = provider(), metamask = provider(), request = metamask.request;
 metamask.request = args => {
  if (args.method === 'eth_getBlockByNumber') return Promise.resolve({hash:'0xblock'});
  if (args.method === 'eth_sendTransaction') { metamask.calls.push(args.method); return Promise.resolve('0x'+'a'.repeat(64)); }
  return request(args);
 };
 const ui = dashboard(other, metamask);
 ui.element('tx-dialog').close = () => {};
 await ui.run('connectWallet()');
 ui.run(`review = {wallet:'${address}',chainId:'0x2694',hostId:'local',transaction:{from:'${address}'}};
 api = async (route, method, body) => ({result:body.method === 'eth_getTransactionReceipt' ? {status:'0x1'} : {hash:'0xblock'}});
 loadChain = async () => {}; load = async () => {};`);
 await ui.run('approveTx()');
 assert.ok(metamask.calls.includes('eth_sendTransaction'));
 assert.equal(other.calls.length, 0);
 assert.equal(ui.element('tx-error').textContent.startsWith('Transaction '), true);
});

test('registration review accepts the decimal wei balance returned by app-evm for funded wallets', async () => {
 const ui = dashboard(provider());
 ui.element('tx-dialog').showModal = () => {};
 ui.run(`wallet='${address}'; rows=[{id:'saved',hostId:'local',role:'validator',name:'Validator',setup:{}}];selected='local:saved';
 api=async (route) => route === '/rpc' ? {result:'3500100000000000000000000'} : {wallet:'${address}',label:'Register validator',transaction:{}};`);
 await ui.run("prepareTx('registerValidator',{amount:'3000000'})");
 assert.equal(ui.element('global-error').textContent, '');
 assert.equal(ui.run('review.wallet'), address);
});

test('registration review still reserves balance for fees with decimal or hexadecimal RPC results', async () => {
 for (const result of ['1000000000000000000','0xde0b6b3a7640000']) {
  const ui=dashboard(provider());
  ui.run(`wallet='${address}';rows=[{id:'saved',hostId:'local',role:'validator',name:'Validator',setup:{}}];selected='local:saved';
  api=async route=>route==='/rpc'?{result:'${result}'}:{wallet:'${address}',transaction:{}};`);
  await ui.run("prepareTx('registerValidator',{amount:'1'})");
  assert.match(ui.element('global-error').textContent, /Leave some GRPH/);
  assert.equal(ui.run('review'), null);
 }
});

test('balance RPC failures and malformed balances never open a registration review', async () => {
 for (const response of [{error:{message:'Host RPC offline'}},{result:null},{result:-1},{result:'-1'},{result:'1.5'}]) {
  const ui=dashboard(provider());
  ui.run(`wallet='${address}';rows=[{id:'saved',hostId:'local',role:'validator',setup:{}}];selected='local:saved';
  api=async route=>route==='/rpc'?${JSON.stringify(response)}:{wallet:'${address}',transaction:{}};`);
  await ui.run("prepareTx('registerValidator',{amount:'1'})");
  assert.match(ui.element('global-error').textContent,/wallet is connected/);
  assert.equal(ui.run('review'),null);
 }
});

test('existing nodes resume guidance from their actual state without creating another identity', () => {
 const scenarios=[
  {node:{chainOnly:true,active:false},state:null,wallet:null,copy:/Connect this node’s host/},
  {node:{unlocked:false,status:{state:'locked'}},state:null,wallet:null,copy:/Unlock the existing identity/},
  {node:{unlocked:true,status:{state:'stopped'}},state:null,wallet:null,copy:/Connect the owner wallet/},
  {node:{unlocked:true,status:{state:'stopped'}},state:{registration:null},wallet:address,copy:/Register this identity/},
  {node:{role:'sentry',unlocked:true,status:{state:'stopped'}},state:{registration:{active:false},ownerMatches:true},wallet:address,copy:/This registration is inactive/},
  {node:{unlocked:true,status:{state:'stopped'}},state:{registration:{registered:true},ownerMatches:true},wallet:address,copy:/Start your registered node/},
 ];
 for(const scenario of scenarios){
  const ui=dashboard(provider());
  const node={id:'saved',hostId:'local',role:'validator',setup:{},...scenario.node};
  ui.run(`rows=[${JSON.stringify(node)}];selected='local:saved';chainState=${JSON.stringify(scenario.state)};wallet=${JSON.stringify(scenario.wallet)};renderResumeGuide();`);
  assert.match(ui.element('node-setup-guide').innerHTML,scenario.copy);
 }
});
