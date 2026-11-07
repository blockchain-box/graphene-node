/* Public UI. Node passwords and private launcher links are sent only to the authenticated local manager. */
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brief = value => value ? value.slice(0, 8) + '…' + value.slice(-4) : '';
const launchOptions = new URLSearchParams(location.search);
let token = location.hash.slice(1);
try {
 if (/^[a-f0-9]{64}$/i.test(token)) sessionStorage.setItem('graphene-launcher-access', token);
 else token = sessionStorage.getItem('graphene-launcher-access') || '';
} catch { /* The original private link still works without browser storage. */ }
history.replaceState(null, '', location.pathname + location.search);
let hosts = [], rows = [], hostErrors = [], filter = 'all', selected = null, wallet = null, imported = null;
let ownerSentries=[], ownerRequests=[], ownerRequestErrors=[], ownerRequestSequence=0, ownerRequestLoading=false, ownerRequestContext='', ownerRequestMarkup=null;
let loadWaiters = [];
let importMode = false, readingFile = 0, loading = false, chainState = null, chainKey = '', review = null, txBusy = false;
const keyFor = row => row.hostId + ':' + row.id;
const current = () => [...rows,...walletRows,...ownerSentries].find(row => keyFor(row) === selected);
function errorMessage(error) { return error?.code === 4001 ? 'You cancelled the request in your wallet. Nothing was submitted.' : error?.data?.message || error?.message || 'This action could not be completed. Please try again.'; }
function actionIcon(name,extra=''){return `<img class="action-icon ${extra}" src="/launcher-icons/${name}.svg" alt="" aria-hidden="true">`;}
function decorateActionIcons(root=document){for(const element of root.querySelectorAll?.('[data-icon]')||[]){if(!element.querySelector?.('.action-icon'))element.insertAdjacentHTML?.('afterbegin',actionIcon(element.dataset.icon));}}
function setWalletButtonLabel(label){
 const button=$('wallet');button.textContent=wallet&&!walletConnecting?wallet.slice(0,6)+'...'+wallet.slice(-4):label;button.dataset.connected=String(!!wallet);button.ariaHasPopup=wallet?'menu':'false';button.ariaExpanded=String(!!wallet&&!$('wallet-menu').hidden);
 if(wallet)button.insertAdjacentHTML?.('afterbegin','<span class="wallet-status-dot" aria-hidden="true"></span>');else button.insertAdjacentHTML?.('afterbegin',actionIcon(walletConnecting?'loader-circle':'wallet',walletConnecting?'icon-spin':''));
 if(wallet)button.insertAdjacentHTML?.('beforeend',actionIcon('chevron-down'));
}
function closeWalletMenu(){if($('wallet-menu'))$('wallet-menu').hidden=true;$('wallet').ariaExpanded='false';}
async function toggleWalletMenu(){
 if(!wallet){await connectWallet();return;}
 const menu=$('wallet-menu');menu.hidden=!menu.hidden;$('wallet').ariaExpanded=String(!menu.hidden);if(menu.hidden)return;
 const account=wallet,host=current()?.hostId||$('wallet-source').value||'local';$('wallet-menu-address').textContent=account;$('wallet-menu-balance').textContent='Checking…';
 try{const result=await api('/rpc','POST',{method:'eth_getBalance',params:[account,'latest']},host);if(wallet!==account)return;if(result.error||typeof result.result!=='string'||!/^(?:0x[0-9a-f]+|\d+)$/i.test(result.result))throw new Error();$('wallet-menu-balance').textContent=formatGrph(result.result)+' GRPH';}catch{if(wallet===account)$('wallet-menu-balance').textContent='Unavailable';}
}
function disconnectWallet(){wallet=null;chainState=null;review=null;closeWalletMenu();setWalletButtonLabel('Connect wallet');useConnectedWallet();void updateWalletNetwork();if(current()){renderDetail();void loadChain();}}

function showError(error) { $('global-error').textContent = errorMessage(error);if($('drawer-error'))$('drawer-error').textContent=errorMessage(error); }
function announce(message) { $('activity').hidden = false; $('activity').textContent = message; }
async function api(route, method = 'GET', body, host = 'local') {
 const remote = host !== 'local';
 const response = await fetch(remote ? '/manager/remotes/' + host + '/proxy' : '/manager' + route, {
  method: remote ? 'POST' : method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  ...(remote || method !== 'GET' ? { body: JSON.stringify(remote ? { route, method, body } : body || {}) } : {}), signal: AbortSignal.timeout(route==='/doctor'?60000:['/share','/remotes'].includes(route) ? 120000 : 25000),
 });
 const data = await response.json();
 if (!response.ok){const message=data.error||'The launcher could not complete this action.';if(/not supported/i.test(message)&&route.endsWith('/reset'))throw new Error('Restart the launcher on this host from the updated folder to enable checkpoint reset.');if(/not supported/i.test(message)&&route.endsWith('/remove'))throw new Error('Restart the launcher on this host from the updated folder to enable deleting saved nodes.');if(/not supported/i.test(message)&&(body?.action==='fundAgent'||route==='/doctor'))throw new Error('This host is running an older launcher backend. Restart its launcher from the updated folder to enable agent funding and Doctor. Docker node services keep running.');throw new Error(message);}
 return data;
}
function labels(state) { return ({ locked:'Locked · status unknown', starting:'Starting…', stopping:'Stopping…', running:'Running', syncing:'Catching up', stopped:'Stopped', error:'Needs attention', unavailable:'Status unavailable' })[state] || 'Checking…'; }
function hostUnavailable(node) { return hostErrors.some(host => host.id === node.hostId); }
function nodeGuidance(node) {
 const state = node.status?.state;
 if (state === 'unavailable') return hostUnavailable(node)
  ? ['Reconnect this server', 'The server cannot be reached. Reconnect it to see the current status and use its controls.']
  : ['Check Docker and node status', 'The launcher is connected, but it cannot check this node. Make sure Docker is running on the node host, then refresh its status.'];
 if (!node.setup) return ['Open your saved node', 'Use the original public setup file and node password to reopen this node.'];
 if (!node.unlocked) return ['Unlock to manage', 'Enter your node password to check its live status. Locking controls does not stop a running node.'];
 if (state === 'error') return ['Check the reported issue', 'Read the error below before trying again. If it continues, share the message with your provider.'];
 if (state === 'syncing') return ['Catching up with the network', 'Your node is downloading recent blocks. Keep it running while it catches up.'];
 if (state === 'starting' || state === 'stopping') return ['Please wait', 'The status refreshes automatically while this action completes.'];
 if (state === 'running') return node.status.agentRunning ? ['Your node is running', 'Check its network connections and registration below.'] : ['Resume node management', 'The node is running, but its management service is stopped. Choose Resume agent to restart that service.'];
 if (state === 'stopped') return ['Ready for the next step', 'Before starting for the first time, connect the owner wallet and complete registration below.'];
 return ['Checking node status', 'Wait for a status update before starting or stopping this node.'];
}
function hostLabel(id) { return hosts.find(h => h.id === id)?.label || id; }
function renderHosts() {
 $('hosts').innerHTML = hosts.map(h => `<button class="host-button" data-host="${escapeHtml(h.id)}" aria-pressed="${filter === h.id}">${escapeHtml(h.label)}${h.connected ? '' : ' · reconnect'}</button>`).join('');
 $('hosts').querySelectorAll('[data-host]').forEach(button => button.onclick = () => { filter = button.dataset.host; renderHosts(); renderList(); });
 $('all-hosts').setAttribute('aria-pressed', String(filter === 'all'));
}
function renderNodeTable(nodes,walletList=false) {
 const attribute=walletList?'data-wallet-node':'data-node';
 return `<div class="node-table-scroll"><table class="node-table"><caption class="sr-only">${walletList?'Nodes registered to the wallet':'Nodes on connected hosts'}. Select a node to open its details.</caption><thead><tr><th scope="col">Node</th><th scope="col" class="node-location-column">Location</th><th scope="col">Status</th><th scope="col" class="node-next-column">Next step</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead><tbody>${nodes.map(node=>{
  const linked=walletList?linkedWalletNode(node):node,key=keyFor(linked||node);
  const state=walletList?(node.active?'registered':'inactive'):node.status?.state;
  const label=walletList?(node.active?'Registered':'Inactive'):labels(state);
  const hint=linked?nodeGuidance(linked)[0]:'Connect host for live controls';
  return `<tr ${attribute}="${escapeHtml(key)}" data-selected="${selected===key}"><td><button class="table-node-name" data-icon="${node.role==='validator'?'shield-check':'server'}" aria-label="Open ${escapeHtml(node.name)} details">${escapeHtml(node.name)}</button><span class="node-meta">${node.role==='sentry'?'Sentry':'Validator'}${walletList?' · '+escapeHtml(brief(node.setup.agentAddress)):''}</span></td><td class="node-location-column">${linked?escapeHtml(hostLabel(linked.hostId)):'Host not connected'}</td><td><span class="status" data-state="${escapeHtml(state)}">${escapeHtml(label)}</span></td><td class="node-next-column">${escapeHtml(hint)}</td><td><img class="table-chevron" src="/launcher-icons/chevron-right.svg" alt=""></td></tr>`;
 }).join('')}</tbody></table></div>`;
}
function openNodeDrawer() {
 const drawer=$('detail');drawer.hidden=false;
 if(!drawer.open)drawer.showModal?.();
}

function renderList() {
 const scoped = rows.filter(r => filter === 'all' || r.hostId === filter);
 const search = $('node-search').value.trim().toLowerCase(), status = $('status-filter').value;
 const visible = scoped.filter(r => (!search || (r.name + ' ' + hostLabel(r.hostId)).toLowerCase().includes(search)) && (status === 'all' || (status === 'attention' ? ['error','unavailable'].includes(r.status?.state) : r.status?.state === status)));
 const running = scoped.filter(r => r.status?.state === 'running').length;
 $('summary').innerHTML = `<div><strong>${scoped.length}</strong>Saved nodes<small>${filter === 'all' ? 'Across all locations' : escapeHtml(hostLabel(filter))}</small></div><div><strong>${running}</strong>Running<small>Reporting a running node</small></div><div><strong>${scoped.filter(r => ['error','unavailable'].includes(r.status?.state)).length}</strong>Needs attention<small>Errors or unreachable servers</small></div><div><strong>${scoped.filter(r => r.status?.state === 'locked').length}</strong>Locked controls<small>Unlock to check live status</small></div>`;
 $('list-caption').textContent = visible.length + ' of ' + scoped.length + ' nodes shown · Select a node to manage it';
 $('list-title').textContent = filter === 'all' ? 'Nodes on connected hosts' : hostLabel(filter);
 const warnings = hostErrors.filter(h => filter === 'all' || filter === h.id).map(h => `<div class="notice"><strong>${escapeHtml(h.label)}</strong><p>${escapeHtml(h.error)}</p></div>`).join('');
 $('nodes').innerHTML = warnings + (visible.length ? renderNodeTable(visible) : scoped.length ? `<div class="empty"><h2>No matching nodes</h2><p>Try another name, location or status.</p><button id="clear-filters">Clear search and status</button></div>` : `<div class="empty"><h2>${filter === 'all' ? 'No saved nodes on connected hosts' : 'No saved nodes in this location yet'}</h2><p>Connect the host of a registered node or reopen its saved identity for live controls. Choose Add node to prepare a new identity.</p><div class="actions"><button id="empty-add" class="primary">Add a node</button></div></div>`);
 $('nodes').querySelectorAll('[data-node]').forEach(button => button.onclick = () => selectNode(button.dataset.node));
 if ($('clear-filters')) $('clear-filters').onclick = () => { $('node-search').value = ''; $('status-filter').value = 'all'; renderList(); };
 if ($('empty-add')) $('empty-add').onclick = () => openAdd();decorateActionIcons();
}
async function load(force = false) {
 if (loading) { await new Promise(resolve => loadWaiters.push(resolve)); if (force) return load(); return; }
 loading = true;
 try {
  hosts = (await api('/hosts')).hosts;
  const previous = rows; hostErrors = [];
  const parts = await Promise.all(hosts.map(async host => {
   if (!host.connected) { hostErrors.push({ ...host, error: 'Reconnect with the server’s Grph P2P connection link to check its nodes.' }); return previous.filter(r => r.hostId === host.id).map(r => ({ ...r, status:{state:'unavailable'}, unlocked:false })); }
   try { return (await api('/nodes', 'GET', null, host.id)).nodes.map(node => ({ ...node, hostId:host.id })); }
   catch (error) { hostErrors.push({ ...host, error:errorMessage(error) }); return previous.filter(r => r.hostId === host.id).map(r => ({ ...r, status:{state:'unavailable'}, unlocked:false })); }
  }));
  rows = parts.flat(); renderHosts(); renderList(); renderWalletInventory();
  if (selected && current()) updateStatus();
 } catch (error) { showError(error); }
 finally { loading = false; for (const resolve of loadWaiters.splice(0)) resolve(); }
}
function updateGuideLink() { const node = current(); $('setup-guide').href = '/operator/guide?role=' + (node?.role || $('node-role').value) + '&location=' + (node ? node.hostId === 'local' ? 'local' : 'server' : launchOptions.get('location') === 'server' ? 'server' : 'local'); }
function selectNode(key, revealDetail = false) {
 const pageX=window.scrollX||0,pageY=window.scrollY||0;
 selected = key; chainState = null; chainKey = ''; renderList(); renderDetail(); renderWalletInventory(); updateGuideLink();

 $('detail-title')?.focus({preventScroll:true});
 window.scrollTo?.({left:pageX,top:pageY,behavior:'instant'});
 void loadChain();
}
function updateStatus() {
 const node = current(); if (!node || node.chainOnly || !$('selected-status')) return;
 if($('delete-node'))$('delete-node').disabled=!node.unlocked||node.status?.state!=='stopped'||removingNodes.has(keyFor(node));
 const guidance = nodeGuidance(node); $('next-title').textContent = guidance[0]; $('next-copy').textContent = guidance[1];
 $('selected-status').textContent = labels(node.status?.state);
 $('selected-status').dataset.state = node.status?.state || '';
 $('metric-height').textContent = node.status?.height ?? '—';
 $('metric-peers').textContent = node.status?.peers ?? '—';
 $('metric-agent').textContent = !node.unlocked || node.status?.state === 'unavailable' ? 'Unknown' : node.status?.agentRunning ? 'Running' : 'Not running';
 $('node-error').textContent = [node.status?.error, node.status?.statusError, node.status?.syncError].filter(Boolean).join(' ');
 const agentIssue=node.status?.agentError;$('agent-connection-alert').hidden=!agentIssue;$('agent-connection-error').textContent=agentIssue&&/bad public key size|registered sentry encryption key/i.test(agentIssue)?'Agent connection needs attention. Your node is unlocked; inspect the failing sentry in Connections.':agentIssue||'';if($('review-agent-connection'))$('review-agent-connection').onclick=()=>activateDrawerTab('connections');
 const busy = ['starting','stopping'].includes(node.status?.state);
 const registered = node.role === 'sentry' ? !!chainState?.registration?.active && chainState.endpointMatches !== false : !!chainState?.registration?.registered;
 const canStart = !!wallet && registered && chainState?.ownerMatches && !chainState?.exit?.requested;
 $('start-node').disabled = !canStart || !node.unlocked || busy || ['unavailable','locked'].includes(node.status?.state) || (node.status?.state === 'running' && node.status.agentRunning);
 $('start-node').textContent = ['running','syncing'].includes(node.status?.state) && !node.status.agentRunning ? 'Resume agent' : 'Start node';
 $('reset-node').disabled = !canStart || !node.unlocked || node.status?.state !== 'stopped';
 if($('downtime-impact'))$('downtime-impact').innerHTML=node.role==='validator'?renderDowntimeImpact(chainState):'';
 $('stop-node').disabled = !node.unlocked || busy || ['stopped','locked','unavailable'].includes(node.status?.state);
 $('unlock-node').hidden = node.unlocked;
 $('lock-node').hidden = !node.unlocked;
 $('lock-node').disabled = busy;
 const connections = node.status?.connections || [];
 $('live-connections').hidden = !connections.length;
 $('live-connections').innerHTML = connections.length ? '<h3>Live peer connections</h3>' + connections.map(connection => `<p>${escapeHtml(brief(connection.validator))}: ${connection.peerConnected ? 'Peer connected (verified)' : connection.proxyListening ? 'Tunnel open · waiting for peer handshake' : 'Not connected yet'}</p>`).join('') : '';
 const checkpoint = node.status?.checkpoint;
 $('checkpoint').hidden = !checkpoint;
 if (checkpoint) $('checkpoint').textContent = 'Fast sync: ' + checkpoint.phase + (checkpoint.height ? ' · checkpoint block ' + checkpoint.height : '');
 renderResumeGuide();
}
function invalidAssignedSentries(node,state){
 if(node?.role!=='validator'||!state)return [];
 return state.sentries.filter(sentry=>sentry.encryptionKeyValid===false&&state.assignments.some(assignment=>assignment.sentryId?.toLowerCase()===sentry.sentryId?.toLowerCase()&&String(assignment.status).toLowerCase()==='active'));
}
function connectionIssueMarkup(node,state){
 const invalid=invalidAssignedSentries(node,state);
 return invalid.length?invalid.map(sentry=>`<div class="notice connection-issue"><h3>${escapeHtml(sentry.name||sentry.sentryId)} cannot receive encrypted connections</h3><p>Its registered X25519 encryption key has ${String(sentry.encryptionPublicKey||'').length} characters. A valid key is 32 bytes encoded as 64 hexadecimal characters (an optional 0x prefix is allowed).</p><p>Your node is unlocked. The sentry owner/provider must replace the invalid registration or provide a valid sentry. Review revoking this unusable assignment below before requesting a replacement. Funding or changing your node keys cannot fix that sentry’s key.</p></div>`).join(''):'';
}
function renderResumeGuide() {
 const node=current(); if(!node || !$('node-setup-guide'))return;
 const steps=['Node host','Unlock identity','Owner wallet','Registration','Fund agent','Start node','Connections'];
 const state=chainState, registered=node.role==='sentry'?!!state?.registration:!!state?.registration?.registered;
 let step=0,title='Connect this node’s host',copy='This registration already exists. Connect its original host and reopen the saved identity to check status and continue.',action='Open saved identity',run=()=>{$('wallet-open-identity')?.click();};
 if(!node.chainOnly && !node.setup){copy='Reopen this node from its original public setup file. Its encrypted identity must already exist on the chosen host.';run=()=>openAdd(true,node.hostId);}
 else if(!node.chainOnly && node.status?.state==='unavailable' && hostUnavailable(node)){title='Reconnect this server';copy='Reconnect the original node host before checking its status or starting it.';action='Connect a server';run=()=>$('add-server').click();}
 else if(!node.chainOnly && node.status?.state==='unavailable'){title='Check Docker and node status';copy='The launcher is connected. Make sure Docker is running on this node’s host, then refresh its status.';action='Refresh status';run=()=>load(true);}
 else if(!node.chainOnly && !node.unlocked){step=1;title='Unlock the existing identity';copy='Use the original node password. The saved keys and node data stay on this host.';action='Unlock node';run=openUnlock;}
 else if(!node.chainOnly && !wallet){step=2;title='Connect the owner wallet';copy='Connect the account that owns this registration, or the account you will use to register this node.';action='Connect wallet';run=connectWallet;}
 else if(!node.chainOnly && !state){step=3;title='Check registration';copy='Read this node’s registration from its host before continuing. A connected wallet alone does not confirm network availability.';action='Check registration';run=()=>loadChain();}
 else if(!node.chainOnly && !registered){step=3;title='Register this identity';copy='Complete the registration fields below, then review and approve in your wallet. This uses your existing node identity.';action='Go to registration';run=()=>{activateDrawerTab('node');const panel=$('registration-panel');panel.scrollIntoView({behavior:'smooth',block:'start'});(panel.querySelector('input')||$('register-node'))?.focus({preventScroll:true});};}
 else if(!node.chainOnly && !state.ownerMatches){step=2;title='Select the owner account';copy='The connected account does not own this saved node. Select its original owner account in your wallet, then check again.';action='Check owner account';run=()=>loadChain();}
 else if(!node.chainOnly && node.role==='sentry' && !state.registration.active){step=3;title='This registration is inactive';copy='This sentry is registered but inactive on the network. Ask your provider to restore its active registration. The launcher cannot reactivate it with the available wallet actions.';action='Check registration again';run=()=>loadChain();}
 else if(!node.chainOnly && state.exit?.requested){step=3;title='Validator exit is in progress';copy='This validator has an exit request. Review its committed removal and unbonding status below before changing its runtime.';action='Review exit status';run=()=>activateDrawerTab('staking');}
 else if(!node.chainOnly && node.role==='validator' && state.agentFunding?.status==='empty'){step=4;title='Fund your validator agent';copy='The agent account is empty and this network charges publication fees. Review a GRPH transfer to its public address below. Owner stake does not fund the agent.';action='Review agent funding';run=()=>activateDrawerTab('agent');}
 else if(!node.chainOnly && (!['running','syncing'].includes(node.status?.state)||!node.status?.agentRunning)){step=5;title=['starting','stopping'].includes(node.status?.state)?'Wait for the node to finish':node.status?.state==='running'?'Resume node management':'Start your registered node';copy='Start the saved node on its host. Registration and its encrypted identity are already in place.';action='Start node';run=()=>operate('start');}
 else if(!node.chainOnly){step=6;title='Check node connections';copy=node.role==='validator'?'Request a sentry connection below and wait for approval. Check live peer status after approval.':'Review validator requests below and check live peer status after approval.';action='Review connections';run=()=>activateDrawerTab('connections');}
 const guide=$('node-setup-guide');
 guide.innerHTML=`<h3>Guided setup${node.chainOnly || node.status?.state!=='running'?' · continue where you left off':''}</h3><ol class="resume-steps" aria-label="Node setup steps">${steps.map((label,index)=>`<li ${index===step?'aria-current="step"':''}>${escapeHtml(label)}</li>`).join('')}</ol><p class="dialog-copy">Step ${step+1} of ${steps.length}</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy)}</p><div class="actions"><button id="resume-action" data-icon="arrow-right" class="primary">${escapeHtml(action)}</button>${node.chainOnly?'<button id="resume-host">Connect node host</button>':''}</div>`;
 $('resume-action').onclick=run;
 $('resume-action').disabled=step===5 && ['starting','stopping'].includes(node.status?.state);
 if($('resume-host'))$('resume-host').onclick=()=>$('add-server').click();
}
let activeDrawerTab='node',drawerSelection=null;
const doctorReports=new Map(),doctorBusy=new Set();
function drawerHeader(node){
 const tabs=[['node','Node'],['connections','Connections'],['agent','Agent'],...(node.role==='validator'?[['staking','Staking']]:[]),['monitor','Monitor'],['doctor','Doctor']];
 return `<div class="drawer-head"><div class="detail-top"><div><h2 id="detail-title" tabindex="-1">${escapeHtml(node.name)}</h2><p class="muted">${node.role==='sentry'?'Sentry':'Validator'} · ${escapeHtml(hostLabel(node.hostId))}</p></div><button id="close-detail" aria-label="Close node details"><img src="/launcher-icons/x.svg" width="18" height="18" alt=""></button></div><div class="drawer-tabs" role="tablist" aria-label="Node information">${tabs.map(([id,label])=>`<button id="drawer-tab-${id}" role="tab" data-drawer-tab="${id}" aria-selected="${activeDrawerTab===id}" tabindex="${activeDrawerTab===id?'0':'-1'}">${actionIcon(({node:'server',connections:'link-2',agent:'wallet',staking:'coins',monitor:'layers',doctor:'stethoscope'})[id])}${label}</button>`).join('')}</div></div>`;
}
function renderNodeIdentity(node){
 const setup=node.setup||{},fields=[['Agent address',setup.agentAddress],['Tendermint peer ID',setup.nodeId],['Tendermint validator address',node.role==='validator'?setup.tendermintValidatorAddress:'Not applicable · sentries do not vote'],...(node.role==='validator'?[['Consensus public key',setup.consensusPublicKey]]:[['Registered peer endpoint',setup.p2pHost?setup.p2pHost+':'+setup.p2pPort:null]])];
 return `<section class="node-identity"><h3>Node identity</h3><dl class="identity-list">${fields.map(([label,value])=>`<div><dt>${label}</dt><dd class="mono">${escapeHtml(value||'Not available · unlock or reopen this identity')}</dd></div>`).join('')}</dl></section>`;
}
const monitorReports=new Map(),monitorBusy=new Set();
function monitorPanel(node){return `<section id="drawer-monitor" data-node-pane="monitor" role="tabpanel" aria-labelledby="drawer-tab-monitor"><h3>Machine monitor</h3><p>Whole-machine usage on ${escapeHtml(hostLabel(node.hostId))}, including all nodes and other applications. Updates every 6 seconds while this tab is open.</p><p class="muted">Storage is the filesystem containing the launcher’s data. Docker volumes may use a different disk. RAM remaining is free memory; cached memory may also be reclaimable.</p><div id="monitor-results" aria-live="polite"></div></section>`;}
function monitorBytes(value){const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return value.toLocaleString(undefined,{maximumFractionDigits:1})+' '+units[index];}
function monitorCard(label,used,remaining,total,usedPercent){return `<div class="monitor-card"><h4>${label}</h4>${usedPercent===null?'<p>Sampling CPU usage…</p>':`<p class="monitor-percentage">${usedPercent.toFixed(1)}% used</p><meter min="0" max="100" value="${usedPercent}" aria-label="${label} used">${usedPercent.toFixed(1)}%</meter>`}<dl><div><dt>Used</dt><dd>${used}</dd></div><div><dt>Remaining</dt><dd>${remaining}</dd></div><div><dt>Total</dt><dd>${total}</dd></div></dl></div>`;}
function renderMonitor(){
 const node=current();if(!node||!$('monitor-results'))return;
 if(node.chainOnly){$('monitor-results').innerHTML='<p class="notice">Connect this node’s original host and open its saved identity to monitor that machine.</p>';return;}
 const report=monitorReports.get(node.hostId);
 if(!report){$('monitor-results').innerHTML='<p role="status">Reading machine usage…</p>';return;}
 if(report.error){$('monitor-results').innerHTML=`<p class="error" role="alert">${escapeHtml(report.error)}</p><p class="muted">The next refresh will try again.</p>`;return;}
 const {cpu,memory,storage}=report,pct=value=>value===null?'—':value.toFixed(1)+'%';
 $('monitor-results').innerHTML=monitorCard('CPU',pct(cpu.usedPercent),pct(cpu.freePercent),cpu.cores+' logical CPUs',cpu.usedPercent)+monitorCard('RAM',monitorBytes(memory.used),monitorBytes(memory.free),monitorBytes(memory.total),memory.usedPercent)+(storage.error?`<div class="monitor-card"><h4>Storage</h4><p class="error">${escapeHtml(storage.error)}</p></div>`:monitorCard('Storage',monitorBytes(storage.used),monitorBytes(storage.free),monitorBytes(storage.total),storage.usedPercent)+(storage.reserved?`<p class="muted">${monitorBytes(storage.reserved)} reserved by the filesystem is excluded from remaining storage.</p>`:''))+`<p class="muted">${escapeHtml(report.hostname)} · Updated ${escapeHtml(new Date(report.sampledAt).toLocaleTimeString())}</p>`;
}
async function loadMonitor(){
 const node=current();if(!node||node.chainOnly||activeDrawerTab!=='monitor'||$('detail').hidden||monitorBusy.has(node.hostId))return;
 const host=node.hostId;monitorBusy.add(host);
 try{const report=await api('/monitor','GET',undefined,host);if(!report.cpu||!report.memory||!report.storage)throw new Error('This host returned an unreadable monitor report. Restart its launcher and try again.');monitorReports.set(host,report);}
 catch(error){const message=errorMessage(error);monitorReports.set(host,{error:/not supported/i.test(message)?'Restart the launcher on this host from the updated folder to enable Monitor.':message});}
 finally{monitorBusy.delete(host);if(current()?.hostId===host)renderMonitor();}
}
function doctorPanel(node){return `<section id="drawer-doctor" data-node-pane="doctor" role="tabpanel" aria-labelledby="drawer-tab-doctor"><h3>Host Doctor</h3><p>Run the read-only prerequisite checks on ${escapeHtml(hostLabel(node.hostId))}. This checks Node.js, Docker, images, bootstrap connectivity and checkpoint trust.</p>${node.chainOnly?'<p class="notice">This checks the selected network-source host. Connect the original node host for diagnostics on that machine.</p>':''}<div class="actions"><button id="run-node-doctor" data-icon="stethoscope">Run Doctor</button></div><div id="doctor-results" aria-live="polite"></div></section>`;}
function initializeDrawer(){
 if(drawerSelection!==selected){drawerSelection=selected;activeDrawerTab='node';}
 $('detail').querySelectorAll('[data-drawer-tab]').forEach(button=>{
  button.onclick=()=>activateDrawerTab(button.dataset.drawerTab);
  button.onkeydown=event=>{const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(event.key))return;event.preventDefault();const buttons=[...$('detail').querySelectorAll('[data-drawer-tab]')],index=buttons.indexOf(button);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;activateDrawerTab(buttons[next].dataset.drawerTab);buttons[next].focus();};
 });
 $('run-node-doctor').onclick=runNodeDoctor;
 renderMonitor();activateDrawerTab(activeDrawerTab);renderDoctorReport();decorateActionIcons($('detail'));
}
function activateDrawerTab(tab){
 const node=current(),allowed=['node','connections','agent','monitor','doctor',...(node?.role==='validator'?['staking']:[])];
 if(!allowed.includes(tab))return;
 activeDrawerTab=tab;$('detail').dataset.tab=tab;$('detail').scrollTop=0;
 if(tab==='monitor')void loadMonitor();
 $('detail').querySelectorAll('[data-drawer-tab]').forEach(button=>{const active=button.dataset.drawerTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
}
function updateDrawerPlaceholders(){
 const node=current(),state=chainState,registered=node?.role==='sentry'?!!state?.registration:!!state?.registration?.registered;
 const message=!state?(wallet?'Checking registration and wallet permissions…':'Connect the owner wallet to load this section.'):!registered?'Register this identity in the Node tab before managing its connections, funding or stake.':!state.ownerMatches?'Connect the wallet registered as this node’s owner to manage this section.':'';
 if($('drawer-placeholders'))$('drawer-placeholders').innerHTML=message?['connections','agent','staking'].map(tab=>`<section class="drawer-empty" data-node-pane="${tab}"><p>${message}</p>${!wallet?'<button data-connect-drawer-wallet>Connect owner wallet</button>':''}</section>`).join(''):'';
 $('detail').querySelectorAll('[data-connect-drawer-wallet]').forEach(button=>button.onclick=connectWallet);
}
function renderDoctorReport(){
 const node=current();if(!node||!$('doctor-results'))return;
 const busy=doctorBusy.has(node.hostId);let report=doctorReports.get(node.hostId);if(report?.checks){const invalid=invalidAssignedSentries(node,chainState);report={...report,ok:report.ok&&!invalid.length,checks:[...report.checks,...invalid.map(sentry=>({ok:false,label:'Encryption key for '+(sentry.name||sentry.sentryId),hint:'Registered key has '+String(sentry.encryptionPublicKey||'').length+' characters; expected 32-byte X25519 hex. Its owner/provider must correct the registration.'}))]};}$('run-node-doctor').disabled=busy;$('run-node-doctor').textContent=busy?'Running Doctor…':'Run Doctor';
 $('doctor-results').innerHTML=busy?'<p role="status">Checking this host. This can take up to 50 seconds.</p>':!report?'<p class="muted">No checks run yet. Doctor does not install software, change keys or stop services.</p>':report.error?`<p class="error" role="alert">${escapeHtml(report.error)}</p>`:`<p class="notice">${report.ok?'All prerequisite checks passed.':'Some host or node checks need attention.'}</p><ul class="doctor-checks">${report.checks.map(check=>`<li><strong class="${check.ok?'check-pass':'error'}">${check.ok?'PASS':'ACTION NEEDED'}</strong><span>${escapeHtml(check.label)}${check.hint?`<small>${escapeHtml(check.hint)}</small>`:''}</span></li>`).join('')}</ul><p class="muted">${escapeHtml(report.note)}</p>`;decorateActionIcons($('detail'));
}
async function runNodeDoctor(){
 const node=current();if(!node||doctorBusy.has(node.hostId))return;
 const host=node.hostId;doctorBusy.add(host);renderDoctorReport();
 try{const report=await api('/doctor','POST',{},host);if(!Array.isArray(report.checks)||typeof report.ok!=='boolean')throw new Error('Doctor returned an unreadable report. Restart the launcher on this host and try again.');doctorReports.set(host,report);}catch(error){doctorReports.set(host,{error:errorMessage(error)});}finally{doctorBusy.delete(host);if(current()?.hostId===host)renderDoctorReport();}
}

function renderDetail() {
 const node=current();if(!node)return;if(node.chainOnly){renderWalletDetail(node);return;}
 $('detail').innerHTML=`${drawerHeader(node)}<p id="drawer-error" class="error" role="alert"></p><section id="node-runtime" data-node-pane="node" role="tabpanel" aria-labelledby="drawer-tab-node"><p id="selected-status" class="status"></p><div class="next-step"><h3 id="next-title"></h3><p id="next-copy"></p></div><dl class="metrics"><div><dt>Latest block</dt><dd id="metric-height">—</dd></div><div><dt>Connected peers</dt><dd id="metric-peers">—</dd></div><div><dt>Management service</dt><dd id="metric-agent">—</dd></div></dl><p id="checkpoint" class="notice" hidden></p><p id="node-error" class="error" role="alert"></p><div id="agent-connection-alert" class="notice" hidden><p id="agent-connection-error"></p><button id="review-agent-connection" class="link-button">Review connection issue</button></div>${renderNodeIdentity(node)}<div class="actions"><button id="unlock-node" data-icon="unlock-keyhole" class="primary">Unlock node</button><button id="start-node" data-icon="play" class="primary">Start node</button><button id="stop-node" data-icon="square">Stop node</button><button id="lock-node" data-icon="lock-keyhole">Lock controls</button></div><p class="muted">Stopping preserves data and signing state. Locking controls leaves Docker nodes running.</p><div id="downtime-impact"></div><details><summary>Recover from a checkpoint</summary><p>For a stopped node: replace its chain data with the latest verified published checkpoint, retain a backup, then start and catch up. Identity and signing history are preserved. Validators require a checkpoint at or above their last signed height.</p><button id="reset-node">Reset from checkpoint &amp; start</button></details><div class="actions"><button id="download-setup" data-icon="download">Download public setup</button></div><details id="node-guide-details" class="node-guidance" ${node.status?.state==='running'?'':'open'}><summary>Setup checklist & next step</summary><section id="node-setup-guide" class="resume-guide" aria-label="Guided node setup"></section></details></section><section id="live-connections" data-node-pane="connections" hidden></section><div id="drawer-placeholders"></div><div id="chain-panel"><section data-node-pane="node"><h3>Registration & wallet</h3><p class="muted">${wallet?'Checking the network…':'Connect your wallet to register, stake and manage connection requests.'}</p></section></div>${monitorPanel(node)}${doctorPanel(node)}`;
 initializeDrawer();openNodeDrawer();
 $('close-detail').onclick=closeNodeDetail;$('unlock-node').onclick=openUnlock;$('lock-node').onclick=()=>operate('lock');$('start-node').onclick=()=>operate('start');
 $('reset-node').onclick=()=>{if(confirm('Reset '+node.name+' from the latest published checkpoint and start it? Its old chain data will be backed up. Identity and signing history will be preserved.'))void operate('reset');};
 $('stop-node').onclick=()=>stopSelectedNode();$('download-setup').onclick=downloadSetup;
 updateStatus();updateDrawerPlaceholders();if(chainState&&chainKey===selected+':'+wallet)renderChain();
}

const removingNodes=new Set();
async function deleteSelectedNode(){
 const node=current();if(!node||node.chainOnly||removingNodes.has(keyFor(node)))return;
 const key=keyFor(node);
 if(!confirm('Delete '+node.name+' from this launcher’s list? Its encrypted identity, node data and signing history will be retained. No on-chain registration or stake will change. You can restore the saved entry using its public setup file and original password.'))return;
 removingNodes.add(key);renderChain();
 try{
  await api('/nodes/'+node.id+'/remove','POST',{},node.hostId);
  rows=rows.filter(row=>keyFor(row)!==key);
  if(selected===key)closeNodeDetail();
  announce('Deleted '+node.name+' from the launcher. Its encrypted identity and data were retained.');
  await load(true);
 }catch(error){showError(error);}
 finally{removingNodes.delete(key);if(selected===key)renderChain();}
}

function participationPercent(value) {
 try {const basis=BigInt(value)*10000n/10n**18n;return (basis/100n)+'.'+(basis%100n).toString().padStart(2,'0')+'%';}catch{return 'Unavailable';}
}
function downtimeCopy(state) {
 const impact=state?.downtime;
 if(!impact||impact.status==='unavailable')return 'Downtime penalty estimate unavailable. Refresh chain state to check participation and stop eligibility.';
 if(impact.status==='exiting')return 'Exit requested: downtime scoring no longer changes. Keep signing until consensus removal is confirmed. Downtime stake deduction under current rules: 0 GRPH.';
 if(impact.status==='awaiting-signature')return 'Awaiting the first signed block: missing probe votes do not reduce stake. Reward weight remains zero until a signature proves readiness. Downtime stake deduction: 0 GRPH.';
 return 'Downtime stake deduction under current rules: 0 GRPH. Missed votes reduce participation and effective voting/reward weight. Current participation: '+participationPercent(impact.score)+'. After 1 missed block: '+participationPercent(impact.projections[0].score)+'. The final impact depends on missed votes while the chain advances; exact GRPH reward loss cannot be calculated in advance.';
}
function renderDowntimeImpact(state) {
 const impact=state?.downtime;
 return '<section class="notice" aria-label="Downtime and penalties"><h3>Downtime & penalties</h3><p>'+escapeHtml(downtimeCopy(state))+'</p>'+(impact?.status==='ready'?'<p>Observed missed votes: '+escapeHtml(impact.missedBlocks)+' / '+escapeHtml(impact.observedBlocks)+'. Current effective weight: '+escapeHtml(formatGrph(impact.effectiveWeightWei))+' GRPH equivalent.</p><table><caption>Projected impact if additional votes are missed</caption><thead><tr><th>Missed blocks</th><th>Participation</th><th>Effective weight reduction</th></tr></thead><tbody>'+impact.projections.map(row=>'<tr><td>'+escapeHtml(row.missedBlocks)+'</td><td>'+participationPercent(row.score)+'</td><td>'+escapeHtml(formatGrph(row.weightReductionWei))+' GRPH equivalent</td></tr>').join('')+'</tbody></table><p class="muted">Weight reduction changes consensus and reward allocation; it is not a deduction from staked GRPH.</p>':'')+'</section>';
}
async function stopSelectedNode() {
 const node=current();if(!node)return;
 const selectedAtStart=selected;
 try {
  let copy='';
  if(node.role==='validator'){
   if(!wallet){await connectWallet();if(!wallet)return;}
   const owner=wallet, state=await api('/nodes/'+node.id+'/chain/'+wallet,'GET',null,node.hostId);
   if(selected!==selectedAtStart||wallet!==owner)return;
   if(!state.ownerMatches)throw new Error('Connect the wallet that owns this validator.');
   chainState=state;updateStatus();copy='\n\n'+downtimeCopy(state);
   if(!state.exit?.safeToStop)copy+='\nStopping is blocked until validator exit and consensus removal are confirmed.';
  }
  if(confirm('Stop '+node.name+'? Its node data and signing state will be preserved.'+copy))await operate('stop');
 }catch(error){showError(error);}
}
async function operate(action) {
 const node = current(); if (!node) return;
 try {
  if ((['start','reset'].includes(action) || action === 'stop' && node.role === 'validator') && !wallet) { await connectWallet(); if (!wallet) return; }
  await api('/nodes/' + node.id + '/' + action, 'POST', {wallet,...(action==='reset'?{confirmReset:true}:{})}, node.hostId);
  announce((action === 'lock' ? 'Controls locked for ' : action === 'reset' ? 'Restoring checkpoint for ' : action === 'start' ? 'Starting ' : 'Stopping ') + node.name + '.');
  await load(true);
 } catch (error) { showError(error); }
}
function openUnlock() {
 const node = current(); if (!node) return;
 if (!node.setup) { openAdd(true, node.hostId); return; }
 $('unlock-error').textContent = ''; $('unlock-password').value = '';
 // The dialog description is separate from the selected node’s action button.
 document.querySelector('#unlock-dialog p.dialog-copy').textContent = node.name + ' · ' + hostLabel(node.hostId);
 $('unlock-dialog').dataset.node = selected; $('unlock-dialog').showModal(); $('unlock-password').focus();
}
async function downloadSetup() {
 const node = current(); if (!node) return;
 try {
  const {setup} = await api('/nodes/' + node.id + '/setup', 'GET', null, node.hostId);
  const url = URL.createObjectURL(new Blob([JSON.stringify(setup,null,2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'graphene-' + setup.role + '-setup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
 } catch (error) { showError(error); }
}
// Discover MetaMask without competing for window.ethereum with other extensions.
const walletProviders = new Map();
let walletProvider = null, walletConnecting = false;
window.addEventListener('eip6963:announceProvider', event => {
 const detail = event.detail;
 if (detail?.info?.rdns && typeof detail.provider?.request === 'function') walletProviders.set(detail.info.rdns, detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function findWalletProvider() {
 window.dispatchEvent(new Event('eip6963:requestProvider'));
 const legacy = window.ethereum;
 return walletProviders.get('io.metamask') || legacy?.providers?.find(provider => provider.isMetaMask) ||
  (legacy?.isMetaMask ? legacy : null) || walletProviders.values().next().value || legacy;
}
function onWalletAccountsChanged(accounts) {
 if(!txBusy){review=null;if($('tx-dialog').open)$('tx-dialog').close();}
 wallet = accounts[0] || null; setWalletButtonLabel(wallet ? brief(wallet) : 'Connect wallet');
 chainState = null; useConnectedWallet(); void updateWalletNetwork();
 if (current()) { renderDetail(); void loadChain(); }
}
function onWalletChainChanged() {
 if(!txBusy){review=null;if($('tx-dialog').open)$('tx-dialog').close();}
 chainState = null; useConnectedWallet(); void updateWalletNetwork();
 if (current()) { renderDetail(); void loadChain(); }
}
function selectWalletProvider(provider) {
 if (walletProvider === provider) return;
 walletProvider?.removeListener?.('accountsChanged', onWalletAccountsChanged);
 walletProvider?.removeListener?.('chainChanged', onWalletChainChanged);
 walletProvider = provider;
 provider.on?.('accountsChanged', onWalletAccountsChanged);
 provider.on?.('chainChanged', onWalletChainChanged);
}
async function updateWalletNetwork() {
 const provider = walletProvider;
 $('wallet-network').hidden = !wallet;$('wallet').dataset.networkState='unknown';
 if (!wallet || !provider) return;
 try {
  const chain = await provider.request({method:'eth_chainId'});
  if(provider===walletProvider){$('wallet-network').hidden=!wallet||BigInt(chain)===9876n;$('wallet').dataset.networkState=BigInt(chain)===9876n?'correct':'wrong';}
 } catch { /* Network switching remains available if the wallet cannot report its chain. */ }
}
async function connectWallet() {
 if (walletConnecting) return;
 const provider = findWalletProvider();
 if (!provider) { showError(new Error('Open this dashboard in a browser with MetaMask, or a compatible wallet browser on mobile.')); return; }
 walletConnecting = true; $('wallet').disabled = true; setWalletButtonLabel('Connecting…'); $('global-error').textContent = '';
 try {
  selectWalletProvider(provider);
  const accounts = await provider.request({method:'eth_requestAccounts'});
  if (!accounts?.length) throw new Error('No wallet account was shared. Unlock your wallet and try again.');
  wallet = accounts[0]; chainState = null; useConnectedWallet();
  await updateWalletNetwork();
  if (current()) { renderDetail(); await loadChain(); }
 } catch (error) { showError(error); }
 finally { walletConnecting = false; $('wallet').disabled = false; setWalletButtonLabel(wallet ? brief(wallet) : 'Connect wallet'); }
}
// As in the explorer, account connection and changing networks are separate actions.
async function switchWalletNetwork() {
 if (!walletProvider || !wallet) return;
 $('wallet-network').disabled = true; $('global-error').textContent = '';
 try {
  const host = current()?.hostId || (filter !== 'all' ? filter : $('wallet-source').value || 'local');
  try { await walletProvider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2694'}]}); }
  catch (error) {
   if (error.code !== 4902) throw error;
   await walletProvider.request({method:'wallet_addEthereumChain',params:[{chainId:'0x2694',chainName:'Graphene Network',nativeCurrency:{name:'Graphene',symbol:'GRPH',decimals:18},rpcUrls:[location.origin+'/wallet-rpc/'+host]}]});
  }
  await updateWalletNetwork();
 } catch (error) { showError(error); }
 finally { $('wallet-network').disabled = false; }
}
async function loadChain(background = false) {
 const node = current(); if (!node || (!wallet && !node.chainOnly) || !node.setup) return;
 const key = selected + ':' + wallet;
 try {
  const state = await api(node.chainOnly ? walletNodeRoute(node,'chain') : '/nodes/' + node.id + '/chain/' + wallet, 'GET', null, node.hostId);
  if (selected + ':' + wallet !== key) return;
  const changed = chainKey !== key || JSON.stringify(chainState) !== JSON.stringify(state);
  chainState = state; chainKey = key; if (!background || changed) renderChain();
 } catch (error) {
  if (selected + ':' + wallet !== key || !$('chain-panel')) return;
  if (background && chainState) {
   chainKey = '';
   let warning = $('chain-refresh-error');
   if (!warning) { warning = document.createElement('p'); warning.id = 'chain-refresh-error'; warning.className = 'error'; warning.setAttribute('role', 'alert'); $('chain-panel').append(warning); }
   warning.textContent = 'Registration and requests could not be refreshed. Showing the last update. ' + errorMessage(error);
   return;
  }
  $('chain-panel').innerHTML = `<h3>Registration & wallet</h3><p class="error">${escapeHtml(errorMessage(error))}</p><button id="retry-chain" class="link-button">Try again</button>`;
  $('retry-chain').onclick = () => loadChain();
 }
}
function renderAgentFunding(node,state) {
 const funding=state.agentFunding||{status:'unavailable'},validator=node.role==='validator';
 const balance=funding.balanceWei===undefined?'Unavailable':formatGrph(funding.balanceWei)+' GRPH';
 const fee=funding.gasPriceWei===undefined?'Unavailable':formatGrph(funding.gasPriceWei)+' GRPH / gas';
 const copy=validator?'The validator agent watches approved sentry assignments and publishes encrypted connection details. It uses this separate account to pay publication fees. Tendermint signs votes; this account does not hold your stake.':'The sentry agent reads assignments, decrypts connection details, opens tunnels and verifies peers. It currently submits no automatic blockchain transactions. Approval and decline fees are paid by the owner wallet.';
 const instruction=funding.status==='free'?'No top-up is required at the current zero gas price. Check again if the network fee policy changes.':funding.status==='not-required'?'Funding is optional for this sentry account in the current relay workflow. The owner wallet still needs funds for its own transactions.':funding.status==='empty'?'This validator agent has no GRPH and the network charges fees. Fund it before it needs to publish a connection.':funding.status==='funded'?'This account has funds. The agent checks the estimated publication fee before signing; a positive balance does not guarantee enough for every transaction.':'Balance and fees could not be verified. Refresh before deciding whether a top-up is needed.';
 const optional=funding.status!=='empty';
 return `<section id="agent-funding" data-node-pane="agent" role="tabpanel" aria-labelledby="agent-funding-title"><h3 id="agent-funding-title">Fund the agent</h3><p>${copy}</p><label for="agent-funding-address">Agent address · ${node.role}</label><input id="agent-funding-address" class="mono" value="${escapeHtml(node.setup.agentAddress)}" readonly><div class="actions"><button id="copy-agent-address" data-icon="copy">Copy agent address</button><button id="refresh-agent-funding" data-icon="refresh-cw">Refresh balance & fees</button></div><p id="agent-funding-status" role="status"></p><dl class="metrics"><div><dt>Agent balance</dt><dd>${escapeHtml(balance)}</dd></div><div><dt>Current gas price</dt><dd>${escapeHtml(fee)}</dd></div></dl><p class="notice">${escapeHtml(instruction)}</p><details><summary>What does the agent submit, and how often?</summary><p>For each new validator–sentry connection, the validator owner submits one request, the sentry owner submits one approval, and the validator agent submits one encrypted connection publication after approval. Registration and optional funding are separate transactions.</p><p>The validator agent normally publishes once per approved assignment. It checks an existing pending transaction by its hash rather than creating another publication on every poll. Reading state, keeping a tunnel open, checking health, and signing consensus votes do not create an agent transaction for every block.</p><p>There is no universal GRPH top-up amount. A publication’s fee depends on its estimated gas limit × current gas price. The agent reserves 20% above its gas estimate and checks its balance before signing. Fund the agent address with native GRPH on this same network; staking the owner wallet does not fund it.</p></details>${optional?'<details><summary>Optional GRPH top-up</summary>':''}<label for="agent-funding-amount">GRPH to send to this agent</label><input id="agent-funding-amount" inputmode="decimal" placeholder="Enter amount"><p class="muted">This is a transfer from the connected owner wallet to the address above. Leave funds in your wallet for its transaction fees.</p><div class="actions"><button id="fund-agent" data-icon="send" ${wallet?.toLowerCase()===node.setup.agentAddress.toLowerCase()?'disabled':''}>Review agent funding</button></div>${optional?'</details>':''}</section>`;
}

function renderChain() {
 const node = current(), state = chainState;
 if (!node || !state || !$('chain-panel')) return;
 const fields = [...$('chain-panel').querySelectorAll('input,select')].map(e=>[e.id,e.value]);
 const openSections = [...$('chain-panel').querySelectorAll('details[open]')].map(e=>e.querySelector('summary').textContent.split('(')[0]);
 const focused = $('chain-panel').contains(document.activeElement) ? document.activeElement.id : null;
 const registered = node.role === 'sentry' ? !!state.registration : !!state.registration?.registered;
 let html = `<section id="registration-panel" data-node-pane="node"><h3>Registration & wallet</h3><p class="mono">Owner wallet: ${escapeHtml(node.chainOnly ? node.ownerWallet : wallet)}</p>`;
 if (!registered) {
  html += `<p class="muted">Register this ${node.role} using the connected wallet.</p>`;
  if (node.role === 'validator') html += `<label for="register-amount">GRPH to stake</label><input id="register-amount" inputmode="decimal" placeholder="Enter amount"><p class="muted">The chain checks the current minimum. Leave GRPH for any transaction fees. Each validator needs its own owner wallet account.</p>`;
  else html += `<div class="form-grid"><div><label for="register-country">Country code</label><input id="register-country" maxlength="2" placeholder="e.g. DE"></div><div><label for="register-capacity">Validator capacity</label><input id="register-capacity" type="number" min="1" max="999" placeholder="e.g. 10"></div></div>`;
  html += `<div class="actions"><button id="register-node" class="primary">Review registration</button></div>`;
 } else if (!state.ownerMatches) {
  html += `<div class="notice">${state.identityMatches ? 'This node is registered to a different wallet. Select its owner account in your wallet.' : 'This wallet is registered to a different validator. Select the wallet account for this node.'}</div>`;
  if(!node.chainOnly && node.role==='validator' && !state.identityMatches)html+=`<p class="muted">Created this node by mistake? Delete it from this launcher’s list. Its encrypted identity and node data are retained, and the wallet’s existing validator registration is unchanged.</p><div class="actions"><button id="delete-node" class="danger" ${!node.unlocked||node.status?.state!=='stopped'||removingNodes.has(keyFor(node))?'disabled':''}>${removingNodes.has(keyFor(node))?'Deleting…':'Delete node'}</button></div>${!node.unlocked?'<p class="muted">Unlock this node to verify that it is stopped before deleting it.</p>':node.status?.state!=='stopped'?'<p class="muted">Only a stopped node can be deleted. The launcher must be able to verify its status.</p>':''}`;
 }
 else {
  html += `<p>Registration confirmed for this wallet.${node.role === 'sentry' && !state.registration.active ? ' This sentry is currently inactive.' : ''}</p>`;
  if (node.role === 'sentry') {
   html += `<dl class="metrics"><div><dt>Country</dt><dd>${escapeHtml(state.registration.country)}</dd></div><div><dt>Capacity</dt><dd>${escapeHtml(state.registration.capacity)}</dd></div><div><dt>Pending requests</dt><dd>${state.applications.filter(r=>String(r.status).toLowerCase()==='pending').length}</dd></div></dl><p class="mono">Registered address: ${escapeHtml(state.registration.p2pHost)}:${escapeHtml(state.registration.p2pPort)}</p>`;
   if (state.endpointMatches === false) html += '<div class="notice">The registered address differs from this saved node profile. Reopen the same identity with a public setup file containing the confirmed endpoint before starting it.</div>';
   html += wallet?.toLowerCase() === node.setup.agentAddress.toLowerCase() ? `<details><summary>Update sentry address</summary><p class="muted">This updates the on-chain address. Reopen the same identity with its updated public setup file afterward; the node’s private keys stay unchanged.</p><label for="sentry-host">Reachable hostname</label><input id="sentry-host" value="${escapeHtml(state.registration.p2pHost)}"><label for="sentry-port">Network port</label><input id="sentry-port" type="number" min="1" max="65535" value="${escapeHtml(state.registration.p2pPort)}"><button id="update-sentry-host">Review address update</button></details>` : '<p class="muted">Address changes for this sentry require provider support: the chain’s update method selects a sentry by the signing account.</p>';
  }
  html += '</section>';
  html += renderAgentFunding(node,state);
  html += `<ol class="setup-progress" data-node-pane="node" aria-label="Node setup progress"><li>Identity prepared</li><li>Registration confirmed</li><li>${state.assignments.some(r=>String(r.status).toLowerCase()==='active') ? 'Connection approved · verify live peer status' : node.role==='sentry' ? 'Review validator requests below' : 'Request a sentry connection below'}</li></ol>`;
  if (node.role === 'validator') {
   const exiting = state.exit?.requested;
   const exitCopy = !exiting ? 'Request exit before withdrawing self-stake. Keep your node and sentry connections running until removal is confirmed.'
    : state.exit.safeToStop ? `Consensus removal confirmed. Safe to stop. Withdrawal becomes available at block ${state.exit.withdrawableHeight}.`
    : `Exit requested. Keep this node and its sentry connections running until removal at block ${state.exit.effectiveHeight} is confirmed.`;
   html += `<section id="staking-panel" data-node-pane="staking" role="tabpanel" aria-labelledby="drawer-tab-staking"><h3>Staking</h3>${renderDowntimeImpact(state)}<dl class="metrics staking-summary"><div><dt>Current self-stake</dt><dd>${escapeHtml(formatGrph(state.registration.stake))} GRPH</dd></div><div><dt>Current rewards</dt><dd>${state.rewards?.status==='ready'?escapeHtml(formatGrph(state.rewards.pendingWei))+' GRPH':'Unavailable'}</dd></div></dl><p class="muted">Rewards reflect the latest synced chain state. Refresh before claiming.</p><button id="refresh-staking-rewards" data-icon="refresh-cw" class="link-button">Refresh rewards</button><p class="notice">${escapeHtml(exitCopy)}</p><label for="stake-amount">GRPH amount</label><input id="stake-amount" inputmode="decimal" placeholder="Enter amount"><div class="actions"><button data-icon="plus" data-stake="delegateStake" ${exiting?'disabled':''}>Delegate more</button><button data-icon="coins" data-stake="unDelegateStake" ${exiting&&!state.exit.canWithdraw?'disabled':''}>Withdraw delegation</button></div><div class="actions"><button data-icon="gift" data-stake="claimStakeRewards">Claim rewards</button><button data-icon="log-out" data-stake="removeValidator" class="danger" ${exiting||!state.staking?'disabled':''}>Request validator exit</button><button data-icon="unlock-keyhole" data-stake="unlockStake" ${state.staking&&!state.exit.canWithdraw||state.assignments.some(r=>String(r.status).toLowerCase()==='active')?'disabled':''}>Withdraw self-stake</button></div></section>`;
  }
  html += `<section id="connections-panel" data-node-pane="connections" role="tabpanel" aria-labelledby="drawer-tab-connections"><h3>${node.role === 'sentry' ? 'Validator requests' : 'Sentry connections'}</h3>${connectionIssueMarkup(node,state)}`;
  if (node.role === 'validator') {
   const sentries = state.sentries.filter(s=>s.active && s.encryptionKeyValid!==false && !state.applications.some(r=>r.sentryId?.toLowerCase()===s.sentryId.toLowerCase() && String(r.status).toLowerCase()==='pending') && !state.assignments.some(r=>r.sentryId?.toLowerCase()===s.sentryId.toLowerCase() && String(r.status).toLowerCase()==='active'));
   html += sentries.length ? `<label for="sentry-search">Find a sentry</label><input id="sentry-search" type="search" placeholder="Search name, country or address"><label for="choose-sentry">Request a sentry connection</label><select id="choose-sentry"><option value="">Choose a sentry</option>${sentries.map(s=>`<option value="${escapeHtml(s.sentryId)}">${escapeHtml(s.name)} · ${escapeHtml(s.country)} · capacity ${escapeHtml(s.capacity)}</option>`).join('')}</select><div class="actions"><button id="request-sentry" data-icon="link-2">Review connection request</button></div>` : '<p class="muted">No additional active sentries are available. Pending requests and active connections are listed below.</p>';
  }
  if(node.role==='validator'&&state.sentries.some(s=>s.active&&s.encryptionKeyValid===false))html+='<p class="notice">Some sentries have invalid registered encryption keys and cannot accept a connection. Their owners must correct the registration. Funding or unlocking your node cannot repair their key.</p>';
  const pending = state.applications.filter(r=>String(r.status).toLowerCase()==='pending');
  html += pending.length ? pending.map(r=>`<div class="request">Request #${escapeHtml(r.id)} · ${escapeHtml(brief(node.role==='sentry'?r.validator:r.sentryId))}<div class="actions">${node.role==='sentry'?`<button data-icon="shield-check" data-action="approveApplication" data-id="${escapeHtml(r.id)}">Review approval</button><button data-icon="square" data-action="rejectApplication" data-id="${escapeHtml(r.id)}">Review decline</button>`:`<button data-icon="square" data-action="cancelApplication" data-id="${escapeHtml(r.id)}">Cancel request</button>`}</div></div>`).join('') : '<p class="muted">No pending requests.</p>';
  html += state.assignments.filter(r=>String(r.status).toLowerCase()==='active').map(r=>`<div class="request">Approved connection #${escapeHtml(r.id)} · ${escapeHtml(brief(node.role==='sentry'?r.validator:r.sentryId))}<p class="muted">${r.encryptedConnectionString?'Connection details published; check live peer status above.':'Waiting for the node to publish connection details.'}</p><button class="link-button" data-icon="link-2" data-action="revokeAssignment" data-id="${escapeHtml(r.id)}">Review revoke connection</button></div>`).join('');
  const history = state.applications.filter(r=>String(r.status).toLowerCase()!=='pending');
  const pastConnections = state.assignments.filter(r=>String(r.status).toLowerCase()!=='active');
  if (history.length || pastConnections.length) html += `<details><summary>Request & connection history (${history.length + pastConnections.length})</summary>${history.map(r=>`<p>Request #${escapeHtml(r.id)} · ${escapeHtml(r.status)} · ${escapeHtml(brief(node.role==='sentry'?r.validator:r.sentryId))}</p>`).join('')}${pastConnections.map(r=>`<p>Connection #${escapeHtml(r.id)} · ${escapeHtml(r.status)}</p>`).join('')}</details>`;
  html += '</section>';
 }
 if(!registered||!state.ownerMatches)html+='</section>';
 if (node.chainOnly && wallet?.toLowerCase() !== node.ownerWallet) html = '<div class="notice">Viewing public registration. Connect the owner wallet to approve actions.</div>' + html;
 $('chain-panel').innerHTML = html;
 if(node.chainOnly && wallet?.toLowerCase()!==node.ownerWallet){$('chain-panel').querySelectorAll('button,input,select').forEach(e=>e.disabled=true);const connect=document.createElement('button');connect.textContent='Connect owner wallet';connect.onclick=connectWallet;$('chain-panel').prepend(connect);}
 for (const [id,value] of fields) { const element = $(id); if (element && (element.tagName !== 'SELECT' || [...element.options].some(o=>o.value===value))) element.value=value; }
 $('chain-panel').querySelectorAll('details').forEach(e=>{e.open=openSections.includes(e.querySelector('summary').textContent.split('(')[0]);});
 if (focused) $(focused)?.focus({preventScroll:true});
 if($('refresh-staking-rewards'))$('refresh-staking-rewards').onclick=()=>loadChain();
 if($('copy-agent-address'))$('copy-agent-address').onclick=async()=>{try{await navigator.clipboard.writeText(node.setup.agentAddress);$('agent-funding-status').textContent='Agent address copied.';}catch{$('agent-funding-address').select();$('agent-funding-status').textContent='Select and copy this public address.'}};
 if($('refresh-agent-funding'))$('refresh-agent-funding').onclick=()=>loadChain();
 if($('fund-agent'))$('fund-agent').onclick=()=>prepareTx('fundAgent',{amount:$('agent-funding-amount').value.trim()});
 if ($('update-sentry-host')) $('update-sentry-host').onclick=()=>prepareTx('updateSentryHost',{host:$('sentry-host').value.trim(),port:$('sentry-port').value});
 if ($('delete-node'))$('delete-node').onclick=deleteSelectedNode;
 if ($('register-node')) $('register-node').onclick = () => prepareTx(node.role === 'validator' ? 'registerValidator':'registerSentry', {amount:$('register-amount')?.value,country:$('register-country')?.value,capacity:$('register-capacity')?.value});
 $('chain-panel').querySelectorAll('[data-stake]').forEach(b=>b.onclick=()=>prepareTx(b.dataset.stake,{amount:$('stake-amount')?.value}));
 $('chain-panel').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>prepareTx(b.dataset.action,{id:b.dataset.id}));
 if ($('request-sentry')) {
  $('request-sentry').onclick = () => prepareTx('applyToSentry',{sentryId:$('choose-sentry').value});
  const filterSentries=()=>{const query=$('sentry-search').value.trim().toLowerCase();for(const option of $('choose-sentry').options)option.hidden=!!option.value&&!((option.textContent+' '+option.value).toLowerCase().includes(query));};
  $('sentry-search').oninput=filterSentries;filterSentries();
 }
 decorateActionIcons($('detail'));updateDrawerPlaceholders();if(activeDrawerTab==='doctor')renderDoctorReport();
 if (!node.chainOnly) updateStatus(); else renderResumeGuide();
}
function formatGrph(value) { try { const n=BigInt(value || 0);return (n/10n**18n).toString()+((n%10n**18n)?'.'+(n%10n**18n).toString().padStart(18,'0').replace(/0+$/,''):''); } catch {return 'Unavailable';} }
async function prepareTx(action,input) {
 const node=current();if(!node||!wallet)return;
 const ownerAtStart=wallet.toLowerCase(),selectedAtStart=selected,providerAtStart=walletProvider;
 if(node.chainOnly && wallet.toLowerCase()!==node.ownerWallet){showError(new Error('Connect the wallet that owns this node.'));return;}
 try {
  const prepared=await api(node.chainOnly?walletNodeRoute(node,'transaction'):'/nodes/'+node.id+'/transaction','POST',{wallet,action,input},node.hostId);
  if(action==='registerValidator'||action==='fundAgent'){
   const balance=await api('/rpc','POST',{method:'eth_getBalance',params:[wallet,'latest']},node.hostId);
   if(balance?.error)throw new Error('Your wallet is connected, but the node host could not check its GRPH balance: '+(balance.error.message || 'RPC request failed.'));
   // app-evm returns decimal wei for funded accounts; other RPCs use hex quantities.
   if(typeof balance?.result!=='string'||!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(balance.result))throw new Error('Your wallet is connected, but the node host returned an unreadable GRPH balance. Refresh and try again.');
   const [whole,fraction='']=input.amount.split('.'),amount=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));
   if(amount>=BigInt(balance.result))throw new Error('Leave some GRPH in your owner wallet for transaction fees. Choose a smaller '+(action==='fundAgent'?'funding':'stake')+' amount.');
  }
  if(wallet?.toLowerCase()!==ownerAtStart||selected!==selectedAtStart||walletProvider!==providerAtStart)return;
  review={...prepared,hostId:node.hostId,nodeId:node.id,action,input,route:node.chainOnly?walletNodeRoute(node,'transaction'):'/nodes/'+node.id+'/transaction'};
  $('tx-review').innerHTML=`<p>${escapeHtml(prepared.label)}</p><dl><dt>Node</dt><dd>${escapeHtml(node.name)} · ${escapeHtml(hostLabel(node.hostId))}</dd><dt>Wallet</dt><dd class="mono">${escapeHtml(prepared.wallet)}</dd><dt>Network</dt><dd>Graphene Network · chain 9876</dd><dt>${prepared.funding?'Funding recipient · agent address':'Node account'}</dt><dd class="mono">${escapeHtml(prepared.agentAddress)}</dd>${prepared.connection?`<dt>Validator account</dt><dd class="mono">${escapeHtml(prepared.connection.validator)}</dd><dt>Target sentry</dt><dd class="mono">${escapeHtml(prepared.connection.sentryId)}</dd><dt>${action==='revokeAssignment'?'Connection':'Request'} ID</dt><dd>${escapeHtml(prepared.connection.id)}</dd><dt>What this does</dt><dd>${escapeHtml(({approveApplication:'Allows this validator to connect. A live peer handshake must still be verified.',rejectApplication:'Declines this validator’s connection request.',cancelApplication:'Cancels your pending sentry connection request.',revokeAssignment:'Revokes this approved connection. The agents remove its access.'})[action])}</dd>`:''}</dl>`;
  $('tx-error').textContent='';$('approve-tx').disabled=false;$('approve-tx').textContent='Approve in wallet';$('tx-dialog').showModal();
 }catch(error){showError(error);}
}
async function approveTx() {
 if(!review||txBusy)return;const context=review;let submitted=false,definitiveFailure=false;txBusy=true;$('approve-tx').disabled=true;$('close-tx').disabled=true;
 try {
  const accounts=await walletProvider.request({method:'eth_accounts'}),chain=await walletProvider.request({method:'eth_chainId'});
  if(accounts[0]?.toLowerCase()!==context.wallet.toLowerCase()||chain.toLowerCase()!==context.chainId)throw new Error('Wallet account or network changed. Close this review, reconnect the right wallet and review the action again.');
  const [walletBlock,hostBlock]=await Promise.all([walletProvider.request({method:'eth_getBlockByNumber',params:['0x1',false]}),api('/rpc','POST',{method:'eth_getBlockByNumber',params:['0x1',false]},context.hostId)]);
  if(!walletBlock?.hash||!hostBlock?.result?.hash||walletBlock.hash.toLowerCase()!==hostBlock.result.hash.toLowerCase())throw new Error('The wallet and this node host are on different networks, or the network cannot be verified. Select this host’s Graphene network in your wallet before approving.');
  if(context.connection||context.funding){
   const fresh=await api(context.route,'POST',{wallet:context.wallet,action:context.action,input:context.input},context.hostId);
   if(fresh.transaction.data!==context.transaction.data||fresh.transaction.to!==context.transaction.to||fresh.transaction.from.toLowerCase()!==context.wallet.toLowerCase()||fresh.transaction.value!==context.transaction.value)throw new Error('This request changed. Close this review and refresh the requests.');
  }
  $('approve-tx').textContent='Waiting for wallet…';
  const hash=await walletProvider.request({method:'eth_sendTransaction',params:[context.transaction]});
  if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('The wallet did not return a transaction hash. Check its activity before retrying.');
  submitted=true;
  $('approve-tx').textContent='Waiting for confirmation…';
  $('tx-error').textContent='Transaction '+hash+' submitted. Waiting for the network.';
  const deadline=Date.now()+120000;let confirmed=false;
  while(Date.now()<deadline){const data=await api('/rpc','POST',{method:'eth_getTransactionReceipt',params:[hash]},context.hostId);if(data.error)throw new Error(data.error.message);if(data.result){if(!['0x1','1',1].includes(data.result.status)){definitiveFailure=true;throw new Error(data.result.errorMessage||'The transaction failed on the network. Check your wallet activity before retrying.');}confirmed=true;break;}await new Promise(r=>setTimeout(r,1500));}
  if(!confirmed)throw new Error('Confirmation is still pending for '+hash+'. Check the wallet activity before submitting again.');
  $('tx-dialog').close();announce('Confirmed: '+context.label+'.');await loadChain();await load(true);if(lookupWallet)await loadWalletNodes();await loadOwnerRequests();
 }catch(error){$('tx-error').textContent=errorMessage(error);}
 finally{txBusy=false;$('approve-tx').disabled=submitted&&!definitiveFailure;$('approve-tx').textContent=submitted&&!definitiveFailure?'Submitted · check wallet activity':'Approve in wallet';$('close-tx').disabled=false;}
}
let addStep = 0, addBusy = false, addComplete = false;
function addStepNames() { return ['Choose node','Node location',importMode ? 'Saved identity' : 'Node details',importMode ? 'Unlock identity' : 'Protect identity','Review']; }
function renderAddStep(focus = false) {
 const names = addStepNames();
 $('add-dialog').dataset.step = String(addStep);
 $('add-dialog').dataset.complete = String(addComplete);
 const stage = addComplete ? 3 : addStep === 0 ? 0 : addStep < 3 ? 1 : 2;
 $('setup-lifecycle').innerHTML = ['Choose node','Prepare computer','Protect identity','Register','Fund agent','Start'].map((name,index) => `<li ${index === stage ? 'aria-current="step"' : ''}>${escapeHtml(name)}</li>`).join('');
 $('mode-new').hidden = !importMode || addComplete;
 $('add-steps').innerHTML = names.map((name,index) => `<li ${index === addStep ? 'aria-current="step"' : ''}>${escapeHtml(name)}</li>`).join('');
 document.querySelectorAll('[data-add-step]').forEach(section => section.hidden = addComplete || Number(section.dataset.addStep) !== addStep);
 $('add-step-count').textContent = addComplete ? 'Identity ready' : 'Identity setup · ' + (addStep + 1) + ' of ' + names.length;
 $('add-step-title').textContent = addComplete ? (importMode ? 'Your node is unlocked' : 'Your node identity is ready') : ['How would you like to help the network?','Choose a node location',importMode ? 'Open your public setup file' : 'Tell us about your node',importMode ? 'Unlock your saved identity' : 'Protect your node identity','Review your node'][addStep];
 $('add-back').hidden = addComplete || addStep === 0;
 $('save-node').hidden = addComplete;
 $('save-node').textContent = addStep === 4 ? (importMode ? 'Open & unlock node' : 'Create node identity') : 'Continue';
 $('add-success').hidden = !addComplete;
 $('add-download').hidden = !addComplete;
 $('add-done').hidden = !addComplete;
 $('add-guide').href = '/operator/guide?role=' + (imported?.role || $('node-role').value) + '&location=' + ($('node-host').value === 'local' ? 'local' : 'server');
 if (addStep === 4 && !addComplete) {
  const details = importMode ? imported : {name:$('node-name').value.trim(),role:$('node-role').value};
  const entries = [['Node',details?.name],['Role',details?.role === 'sentry' ? 'Sentry' : 'Validator'],['Location',hostLabel($('node-host').value)],['Identity',importMode ? 'Open the encrypted identity already on this host' : 'Create a separate encrypted identity']];
  if (details?.role === 'sentry') entries.push(['Server',(importMode ? details.host : $('node-address').value.trim()) + ':' + (importMode ? details.port : $('node-port').value)]);
  $('add-review').innerHTML = entries.map(([label,value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
  $('add-next-help').textContent = importMode ? 'This opens the saved identity using its original password. You can then check its registration and live status.' : 'This creates the node identity on your chosen host. Next, save its public setup, register with your owner wallet and start the node.';
 }
 decorateActionIcons($('add-dialog'));
 if (focus) { $('add-step-title').focus(); $('add-dialog').scrollTop = 0; }
}
function validateAddStep() {
 $('add-error').textContent = '';
 if (addStep === 1 && !hosts.some(host => host.connected && host.id === $('node-host').value)) { $('add-error').textContent = 'Choose a connected node location. Connect the server from the dashboard if it is missing.'; return false; }
 if (addStep === 2 && importMode && !imported) { $('add-error').textContent = 'Choose your public setup JSON first.'; return false; }
 if (addStep === 2 && !importMode) {
  $('node-name').setCustomValidity($('node-name').value.trim() ? '' : 'Enter a name for your node.');
  const sentry = $('node-role').value === 'sentry';
  $('node-address').required = sentry; $('node-port').required = sentry;
  $('node-address').setCustomValidity(sentry && (! $('node-address').value.trim() || /[\s/@]/.test($('node-address').value.trim())) ? 'Enter the server hostname or IP address supplied by your provider.' : '');
  $('node-port').setCustomValidity(sentry && !Number.isInteger(Number($('node-port').value)) ? 'Enter a whole port number.' : '');
 }
 if (addStep === 3) {
  $('node-confirm').setCustomValidity(!importMode && $('node-password').value !== $('node-confirm').value ? 'The passwords do not match. Enter the same password twice.' : '');
 }
 const section = document.querySelector('[data-add-step="' + addStep + '"]');
 for (const field of section.querySelectorAll('input,select')) {
  if ((importMode && field.closest('#new-fields')) || (!importMode && field.closest('#import-fields')) || (importMode && field.id === 'node-confirm') || ($('node-role').value !== 'sentry' && field.closest('#sentry-fields'))) continue;
  if (!field.reportValidity()) return false;
 }
 return true;
}
function setMode(useImport) {
 importMode=useImport; readingFile++; imported=null; $('setup-file').value=''; $('node-password').value=''; $('node-confirm').value=''; $('import-info').textContent=''; $('add-error').textContent='';
 $('new-fields').hidden=useImport; $('node-name').required=!useImport; $('node-confirm').required=!useImport; $('import-fields').hidden=!useImport; $('confirm-fields').hidden=useImport;
 $('password-label').textContent=useImport?'Original node password':'Choose a node password'; $('node-password').autocomplete=useImport?'current-password':'new-password';
 renderAddStep();
}
function openAdd(useImport=false, hostOverride) {
 if (addBusy) return;
 $('node-host').innerHTML=hosts.filter(h=>h.connected).map(h=>`<option value="${escapeHtml(h.id)}">${escapeHtml(h.label)}</option>`).join('');
 $('node-host').value=hostOverride || (filter!=='all'&&hosts.some(h=>h.id===filter&&h.connected)?filter:'local');
 addStep=useImport?1:0; addComplete=false; setMode(useImport); $('add-dialog').showModal(); $('add-step-title').focus();
}
async function submitAddNode(event) {
 event.preventDefault(); if (addBusy || addComplete) return;
 if (!validateAddStep()) return;
 if (addStep < 4) { addStep++; renderAddStep(true); return; }
 // Recheck every step before creating an identity, including Enter-key submissions.
 for (let step=1; step<4; step++) { addStep=step; renderAddStep(); if (!validateAddStep()) { renderAddStep(true); return; } }
 addStep=4; renderAddStep();
 const host=$('node-host').value;
 addBusy=true; $('add-form').setAttribute('aria-busy','true');
 for (const id of ['save-node','add-back','close-add']) $(id).disabled=true;
 $('save-node').textContent=importMode?'Opening identity…':'Creating identity…';
 try {
  const source=importMode?imported:{role:$('node-role').value,name:$('node-name').value.trim(),host:$('node-address').value.trim(),port:Number($('node-port').value)};
  const expectedIdentity=imported?Object.fromEntries(['agentAddress','encryptionPublicKey','nodeId','consensusPublicKey','transportPublicKey'].filter(k=>imported[k]).map(k=>[k,imported[k]])):undefined;
  const result=await api('/nodes','POST',{mode:importMode?'import':'new',...source,passphrase:$('node-password').value,...(expectedIdentity?{expectedIdentity}:{})},host);
  $('node-password').value=$('node-confirm').value='';
  await load(true); selectNode(host+':'+result.node.id);
  addComplete=true;
  $('add-success-copy').textContent=result.node.name + (importMode?' is unlocked. Open its controls to check registration and status.':' has been saved on '+hostLabel(host)+'. Complete registration before its first start.');
  renderAddStep(true);
 } catch(error) { $('add-error').textContent=errorMessage(error); }
 finally {
  addBusy=false; $('add-form').setAttribute('aria-busy','false');
  for (const id of ['save-node','add-back','close-add']) $(id).disabled=false;
  if (!addComplete) renderAddStep();
 }
}
function publicSetup(raw){
 if(raw.length>16384)throw new Error('Choose the small public setup file, not a node backup.');
 const data=JSON.parse(raw),allowed=['version','role','name','moniker','agentAddress','encryptionPublicKey','x25519PublicKey','nodeId','tendermintNodeId','consensusPublicKey','tendermintValidatorPublicKey','networkPublicKey','transportPublicKey','grphDhtPublicKey','grphPublicKey','p2pHost','p2pPort','agentRole','fieldDescriptions','tendermintValidatorAddress','validatorAddress','stakeAmount'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!allowed.includes(k)))throw new Error('Choose a public setup JSON. Private key exports and backups cannot be imported here.');
 if(data.agentRole!==undefined && (typeof data.agentRole!=='string'||data.agentRole.length>1000))throw new Error('The setup file has invalid agent documentation.');
 if(data.fieldDescriptions!==undefined && (!data.fieldDescriptions||typeof data.fieldDescriptions!=='object'||Array.isArray(data.fieldDescriptions)||Object.entries(data.fieldDescriptions).some(([key,value])=>!allowed.includes(key)||['agentRole','fieldDescriptions'].includes(key)||typeof value!=='string'||value.length>1000)))throw new Error('The setup file has invalid field descriptions.');
 if(data.version!==undefined&&data.version!==1)throw new Error('Ask your provider for a supported public setup file.');
 const setup={role:data.role,name:data.name||data.moniker,agentAddress:data.agentAddress,encryptionPublicKey:String(data.encryptionPublicKey||data.x25519PublicKey||'').replace(/^0x/,''),nodeId:data.nodeId||data.tendermintNodeId,consensusPublicKey:data.consensusPublicKey||data.tendermintValidatorPublicKey||data.networkPublicKey,transportPublicKey:data.transportPublicKey||data.grphDhtPublicKey||data.grphPublicKey,host:data.p2pHost,port:data.p2pPort===undefined?undefined:Number(data.p2pPort)};
 if(!['validator','sentry'].includes(setup.role)||typeof setup.name!=='string'||!setup.name.trim()||setup.name.length>64||!/^0x[0-9a-f]{40}$/i.test(setup.agentAddress||'')||!/^[0-9a-f]{64}$/i.test(setup.encryptionPublicKey)||!/^[0-9a-f]{40}$/i.test(setup.nodeId||'')||(setup.role==='validator'&&!/^[A-Za-z0-9+/]{43}=$/.test(setup.consensusPublicKey||'')))throw new Error('This file is missing valid node identity fields. Choose the public setup file from your original launcher.');
 if(setup.role==='sentry'&&(typeof setup.host!=='string'||!setup.host||/[\s/@]/.test(setup.host)||!Number.isInteger(Number(setup.port))||Number(setup.port)<1||Number(setup.port)>65535))throw new Error('Ask your provider for a valid sentry hostname and port.');
 return setup;
}
// Public registrations and local encrypted profiles are different inventories.
let walletRows = [], lookupWallet = '', lookupHost = 'local', walletSequence = 0, walletInFlight = 0;
function walletNodeRoute(node, action) {
 return '/wallets/' + node.ownerWallet + '/nodes/' + node.role + '/' + node.setup.agentAddress + '/' + action;
}
function linkedWalletNode(node) {
 return rows.find(r => r.hostId === node.hostId && r.role === node.role && r.setup?.agentAddress?.toLowerCase() === node.setup.agentAddress.toLowerCase() && r.setup.nodeId?.toLowerCase() === node.setup.nodeId?.toLowerCase() && r.setup.encryptionPublicKey?.replace(/^0x/,'').toLowerCase() === node.setup.encryptionPublicKey.toLowerCase() && (r.role !== 'validator' || r.setup.consensusPublicKey === node.setup.consensusPublicKey));
}
function renderWalletInventory() {
 const source = $('wallet-source').value || lookupHost;
 $('wallet-source').innerHTML = hosts.map(h=>`<option value="${escapeHtml(h.id)}" ${h.connected?'':'disabled'}>${escapeHtml(h.label)}${h.connected?'':' · reconnect'}</option>`).join('');
 if ([...$('wallet-source').options].some(o=>o.value===source)) $('wallet-source').value=source;
 $('wallet-use-connected').disabled = !wallet;
 if (!lookupWallet) return;
 $('wallet-results').innerHTML = walletRows.length ? renderNodeTable(walletRows,true) : `<div class="empty"><h3>No nodes registered to this address</h3><p>Choose Add node to prepare a new validator or sentry, or check another network source.</p></div>`;
 $('wallet-results').querySelectorAll('[data-wallet-node]').forEach(b=>b.onclick=()=>selectNode(b.dataset.walletNode,true));decorateActionIcons($('wallet-results'));
}
function clearWalletInventory() {
 const wasDiscovered = current()?.chainOnly;
 walletSequence++; walletRows=[]; lookupWallet='';
 $('wallet-results').replaceChildren(); $('wallet-inventory-status').textContent='Connect your wallet or enter an address to find its registered validators and sentries.';
 if (wasDiscovered) closeNodeDetail();
 renderWalletInventory();
}
async function loadWalletNodes(background=false) {
 if(background && walletInFlight)return;
 const address=background?lookupWallet:$('wallet-address').value.trim(), host=background?lookupHost:$('wallet-source').value || 'local';
 if (!/^0x[0-9a-f]{40}$/i.test(address)) { if (!background) $('wallet-inventory-status').textContent='Enter a wallet address starting with 0x and followed by 40 hexadecimal characters.'; return; }
 const changed=lookupWallet!==address.toLowerCase() || lookupHost!==host;
 if (changed) { if (current()?.chainOnly) closeNodeDetail(); walletRows=[]; $('wallet-results').replaceChildren(); }
 lookupWallet=address.toLowerCase(); lookupHost=host;
 const sequence=++walletSequence;
 walletInFlight=sequence;
 if (!background || changed) $('wallet-inventory-status').textContent='Finding registered validators and sentries…';
 try {
  const data=await api('/wallets/'+lookupWallet+'/nodes','GET',null,host);
  if (sequence!==walletSequence) return;
  walletRows=data.nodes.map(n=>({...n,hostId:host}));
  $('wallet-inventory-status').textContent=walletRows.length+' registered '+(walletRows.length===1?'node':'nodes')+' for '+lookupWallet+' · Network source: '+hostLabel(host)+'. Registration does not verify that a node is running.';
  renderWalletInventory();
  if (selected && !current()) closeNodeDetail();
 } catch(error) {
  if(sequence!==walletSequence)return;
  $('wallet-inventory-status').textContent='Could not refresh wallet registrations. '+(walletRows.length?'Showing the previous results. ':'')+errorMessage(error);
 } finally { if(walletInFlight===sequence)walletInFlight=0; }
}
function closeNodeDetail() {
 const previous=selected;drawerSelection=null;$('detail').close?.();
 selected=null; chainState=null; chainKey=''; $('detail').hidden=true; $('workspace').classList.remove('with-detail'); renderList(); renderWalletInventory();
 const row=[...document.querySelectorAll('[data-node],[data-wallet-node]')].find(row=>(row.dataset.node||row.dataset.walletNode)===previous);row?.querySelector('button')?.focus({preventScroll:true});
}
function renderWalletDetail(node) {
 $('detail').innerHTML=`${drawerHeader(node)}<p id="drawer-error" class="error" role="alert"></p><section id="node-runtime" data-node-pane="node" role="tabpanel" aria-labelledby="drawer-tab-node"><div class="next-step"><h3>Registered node · host not connected</h3><p>Manage this registration with its owner wallet. Connect its host and unlock the existing identity for live runtime controls.</p></div>${renderNodeIdentity(node)}<div class="actions"><button id="wallet-open-identity">Open saved identity</button><button id="wallet-connect-host">Connect node host</button></div><details id="node-guide-details" class="node-guidance" ${node.status?.state==='running'?'':'open'}><summary>Setup checklist & next step</summary><section id="node-setup-guide" class="resume-guide" aria-label="Guided node setup"></section></details></section><div id="drawer-placeholders"></div><div id="chain-panel"><section data-node-pane="node"><h3>Registration & wallet</h3><p class="muted">Checking registration and connections…</p></section></div>${monitorPanel(node)}${doctorPanel(node)}`;
 initializeDrawer();openNodeDrawer();renderResumeGuide();updateDrawerPlaceholders();$('close-detail').onclick=closeNodeDetail;$('wallet-connect-host').onclick=()=>$('add-server').click();
 $('wallet-open-identity').onclick=()=>{openAdd(true,node.hostId);try{imported=publicSetup(JSON.stringify(node.setup));$('import-info').textContent=node.name+' · Public identity loaded. The original keys must already exist on the chosen host.';}catch(error){$('add-error').textContent=errorMessage(error);}};
}

function useConnectedWallet() {
 closeWalletMenu();
 $('header-wallet-status').textContent=wallet?'Wallet '+brief(wallet):'Wallet not connected';
 resetOwnerRequests(); void loadOwnerRequests();
 if(wallet?.toLowerCase()===lookupWallet){$('wallet-address').value=wallet;void loadWalletNodes();return;}
 clearWalletInventory(); $('wallet-address').value=wallet || '';
 if(wallet)void loadWalletNodes();
}
$('wallet-lookup').onsubmit=event=>{event.preventDefault();void loadWalletNodes();};
$('wallet-use-connected').onclick=useConnectedWallet;
$('wallet-source').onchange=()=>{resetOwnerRequests();void loadOwnerRequests();clearWalletInventory();if($('wallet-address').value.trim())void loadWalletNodes();};
async function restoreConnectedWallet() {
 const provider = findWalletProvider(); if (!provider || walletConnecting || wallet) return;
 try {
  const accounts = await provider.request({method:'eth_accounts'});
  if (!walletConnecting && !wallet && accounts?.[0]) {
   selectWalletProvider(provider); wallet = accounts[0]; setWalletButtonLabel(brief(wallet)); useConnectedWallet(); await updateWalletNetwork();
  }
 } catch { /* Connecting explicitly remains available. */ }
}

// Requests are scoped to the signing wallet, never the address in public lookup.
function resetOwnerRequests() {
 const inboxOnlySelection=ownerSentries.some(node=>keyFor(node)===selected)&&![...rows,...walletRows].some(node=>keyFor(node)===selected);
 if(inboxOnlySelection){$('detail').close?.();selected=null;chainState=null;chainKey='';$('detail').hidden=true;$('workspace').classList.remove('with-detail');}
 ownerRequestSequence++; ownerRequestLoading=false; ownerRequestContext=''; ownerRequests=[]; ownerSentries=[]; ownerRequestErrors=[];
 renderOwnerRequests();
}
function renderOwnerRequests() {
 const status=$('owner-requests-status'), list=$('owner-request-list');
 $('refresh-requests').disabled=!wallet || ownerRequestLoading;
 $('refresh-requests').textContent=ownerRequestLoading?'Checking requests…':'Refresh requests';decorateActionIcons($('owner-requests'));
 if(!wallet){status.textContent='Connect your owner wallet to see incoming requests.';list.innerHTML='';ownerRequestMarkup=null;return;}
 status.textContent=ownerRequestLoading?'Checking sentries owned by '+brief(wallet)+'…':ownerRequests.length?ownerRequests.length+' pending '+(ownerRequests.length===1?'request':'requests')+' for your sentries · '+hostLabel($('wallet-source').value||'local'):ownerSentries.length?'No pending requests for your sentries. New requests appear here automatically.':ownerRequestErrors.length?'Requests could not be verified. Refresh to try again.':'No sentries registered to this wallet on the selected network source.';
 const markup=ownerRequestErrors.map(message=>`<p class="owner-request-error">${escapeHtml(message)}</p>`).join('')+ownerRequests.map(item=>`<article class="owner-request-row"><div class="request-context"><h3>Validator ${escapeHtml(brief(item.request.validator))}<span class="request-pill">Pending</span></h3><p class="mono">${escapeHtml(item.request.validator)}</p><p>Wants to join <strong>${escapeHtml(item.node.name)}</strong> · Request #${escapeHtml(item.request.id)}</p><p class="mono">Sentry ${escapeHtml(item.node.setup.agentAddress)}</p>${item.active?'':'<p>This sentry is inactive. Approval is unavailable.</p>'}</div><div class="actions"><button class="primary" data-owner-request="${escapeHtml(item.key)}" data-icon="shield-check" data-decision="approveApplication" ${ownerRequestLoading||!item.active?'disabled':''}>Review approval</button><button data-owner-request="${escapeHtml(item.key)}" data-icon="square" data-decision="rejectApplication" ${ownerRequestLoading?'disabled':''}>Review decline</button></div></article>`).join('');
 if(markup!==ownerRequestMarkup){list.innerHTML=markup;ownerRequestMarkup=markup;}
 decorateActionIcons($('owner-requests'));
 list.querySelectorAll('[data-owner-request]').forEach(button=>button.onclick=()=>reviewOwnerRequest(button.dataset.ownerRequest,button.dataset.decision));
}
async function loadOwnerRequests(background=false) {
 if(!wallet){resetOwnerRequests();return;}
 const owner=wallet.toLowerCase(),host=$('wallet-source').value||'local',context=owner+':'+host;
 if(background && ownerRequestLoading && ownerRequestContext===context)return;
 if(ownerRequestContext!==context){ownerRequests=[];ownerSentries=[];ownerRequestErrors=[];}
 ownerRequestContext=context; const sequence=++ownerRequestSequence;
 ownerRequestLoading=true;if(!background)renderOwnerRequests();
 try {
  const inventory=await api('/wallets/'+owner+'/nodes','GET',null,host);
  const nodes=inventory.nodes.filter(node=>node.role==='sentry'&&node.ownerWallet?.toLowerCase()===owner).map(node=>({...node,hostId:host,ownerWallet:owner}));
  const results=await Promise.allSettled(nodes.map(async node=>{
   const state=await api(walletNodeRoute(node,'chain'),'GET',null,host);
   if(!state.ownerMatches||state.registration?.operator?.toLowerCase()!==owner)throw new Error(node.name+': this wallet no longer owns this sentry.');
   if(!Array.isArray(state.applications))throw new Error(node.name+': the network returned an unreadable request list.');
   return state.applications.filter(request=>request.sentryId?.toLowerCase()===node.setup.agentAddress.toLowerCase()&&String(request.status).toLowerCase()==='pending').map(request=>({key:keyFor(node)+':'+request.id,node,request,active:!!state.registration.active}));
  }));
  if(sequence!==ownerRequestSequence||wallet?.toLowerCase()!==owner)return;
  ownerSentries=nodes;ownerRequests=results.flatMap(result=>result.status==='fulfilled'?result.value:[]);
  ownerRequestErrors=results.filter(result=>result.status==='rejected').map(result=>errorMessage(result.reason));
 } catch(error) {
  if(sequence!==ownerRequestSequence)return;
  ownerRequests=[];ownerSentries=[];ownerRequestErrors=[errorMessage(error)];
 } finally {if(sequence===ownerRequestSequence){ownerRequestLoading=false;renderOwnerRequests();}}
}
async function reviewOwnerRequest(key,action) {
 const item=ownerRequests.find(item=>item.key===key);
 if(!item||!wallet||wallet.toLowerCase()!==item.node.ownerWallet||!['approveApplication','rejectApplication'].includes(action))return;
 if(action==='approveApplication'&&!item.active)return;
 // Reuse the normal transaction review. The manager rechecks owner and pending
 // state against the chain; no encrypted identity or runtime unlock is required.
 selectNode(keyFor(linkedWalletNode(item.node)||item.node),true);activateDrawerTab('connections');
 await prepareTx(action,{id:item.request.id});
}

$('refresh-requests').onclick=()=>loadOwnerRequests();
let drawerPointerOutside=false;
$('detail').addEventListener('pointerdown',event=>{const r=$('detail').getBoundingClientRect();drawerPointerOutside=event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;});
$('detail').addEventListener('click',event=>{if(event.target!==$('detail')||!drawerPointerOutside)return;const r=$('detail').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeNodeDetail();drawerPointerOutside=false;});
$('detail').addEventListener('cancel',event=>{event.preventDefault();closeNodeDetail();});
$('nav-setup').onclick=()=>openAdd();
$('all-hosts').onclick=()=>{filter='all';renderHosts();renderList();};
$('refresh').onclick=()=>{void loadOwnerRequests();void load();void loadChain();if(lookupWallet)void loadWalletNodes();};
$('wallet').onclick=()=>{void toggleWalletMenu();};$('wallet-network').onclick=switchWalletNetwork;$('add-node').onclick=()=>openAdd();$('mode-new').onclick=()=>{addStep=0;setMode(false);};$('mode-import').onclick=()=>{setMode(true);addStep=1;renderAddStep(true);};
function updateRoleHelp() { const sentry = $('node-role').value === 'sentry'; $('role-choice-validator').checked=!sentry; $('role-choice-sentry').checked=sentry; $('sentry-fields').hidden = !sentry; $('role-help').textContent = sentry ? 'A sentry connects validators to the network. Your provider supplies the server address and port.' : 'A validator checks blocks and votes on the network. Registration requires a GRPH stake.'; }
$('node-role').onchange=updateRoleHelp;
$('role-choice-validator').onclick=()=>{$('node-role').value='validator';updateRoleHelp();};
$('role-choice-sentry').onclick=()=>{$('node-role').value='sentry';updateRoleHelp();};
$('node-search').oninput=renderList;
$('status-filter').onchange=renderList;
$('setup-file').onchange=async event=>{const file=event.target.files[0],read=++readingFile;imported=null;$('add-error').textContent='';$('import-info').textContent='';if(!file)return;try{if(file.size>16384)throw new Error('Choose the small public setup JSON, not a node backup.');const raw=await file.text();if(read!==readingFile)return;imported=publicSetup(raw);$('import-info').textContent=imported.name+' · '+imported.role+'. Enter its original password below.';}catch(error){$('add-error').textContent=error instanceof SyntaxError?'This file is not readable JSON. Choose the public setup file.':errorMessage(error);}};
$('add-form').onsubmit=submitAddNode;
$('add-back').onclick=()=>{if(!addBusy && addStep>0){addStep--; if(addStep===0 && importMode)setMode(false); $('add-error').textContent=''; renderAddStep(true);}};
$('add-done').onclick=()=>{$('add-dialog').close(); if(current()){selectNode(selected,true);if($('node-guide-details'))$('node-guide-details').open=true;$('node-setup-guide')?.scrollIntoView({behavior:'smooth',block:'start'});}};
$('add-download').onclick=downloadSetup;
$('node-host').onchange=()=>renderAddStep();
$('add-dialog').addEventListener('cancel',event=>{if(addBusy)event.preventDefault();});
$('add-server').onclick=()=>{$('server-error').textContent='';$('server-link').value='';$('server-dialog').showModal();};
$('setup-connect-server').onclick=()=>{$('add-server').onclick();};
$('server-form').onsubmit=async event=>{event.preventDefault();$('connect-server').disabled=true;$('connect-server').textContent='Connecting via P2P…';try{const connected=await api('/remotes','POST',{label:$('server-name').value,link:$('server-link').value});$('server-link').value='';$('server-dialog').close();await load(true);if($('add-dialog').open){const previousHost=$('node-host').value;$('node-host').innerHTML=hosts.filter(h=>h.connected).map(h=>`<option value="${escapeHtml(h.id)}">${escapeHtml(h.label)}</option>`).join('');$('node-host').value=connected.host?.id||hosts.find(h=>h.label===$('server-name').value)?.id||previousHost;renderAddStep();}announce('Server connected. Select its nodes to manage them here.');}catch(error){$('server-error').textContent=errorMessage(error);}finally{$('connect-server').disabled=false;$('connect-server').textContent='Connect server';}};
$('unlock-form').onsubmit=async event=>{event.preventDefault();const [host,id]=$('unlock-dialog').dataset.node.split(':');$('unlock-submit').disabled=true;try{await api('/nodes/'+id+'/unlock','POST',{passphrase:$('unlock-password').value},host);$('unlock-password').value='';$('unlock-dialog').close();await load(true);announce('Node unlocked. Its current status is shown in the dashboard.');}catch(error){$('unlock-error').textContent=errorMessage(error);}finally{$('unlock-submit').disabled=false;}};
$('approve-tx').onclick=approveTx;
$('tx-dialog').addEventListener('cancel',event=>{if(txBusy)event.preventDefault();});
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{if((button.dataset.close==='tx-dialog'&&txBusy)||(button.dataset.close==='add-dialog'&&addBusy))return;$(button.dataset.close).close();});
$('add-dialog').addEventListener('close',()=>{$('node-password').value=$('node-confirm').value='';});
$('unlock-dialog').addEventListener('close',()=>{$('unlock-password').value='';});
$('server-dialog').addEventListener('close',()=>{$('server-link').value='';});
if (launchOptions.get('role') === 'sentry' || (!launchOptions.has('role') && location.port === '8788')) $('node-role').value = 'sentry';
updateRoleHelp(); updateGuideLink();$('wallet-menu').hidden=true;setWalletButtonLabel('Connect wallet');decorateActionIcons();
$('wallet-copy-address').onclick=async()=>{if(wallet)try{await navigator.clipboard.writeText(wallet);$('wallet-menu-notice').textContent='Address copied.';}catch{$('wallet-menu-notice').textContent='Select and copy the public address above.';}};
$('wallet-disconnect').onclick=disconnectWallet;
document.addEventListener?.('click',event=>{if(!event.target.closest?.('#wallet,#wallet-menu'))closeWalletMenu();});
window.addEventListener('keydown',event=>{if(event.key==='Escape')closeWalletMenu();});
void api('/capabilities').then(info=>{if(!info.features?.includes('agent-funding-v1')){$('launcher-version-notice').hidden=false;}}).catch(error=>{if(/not supported/i.test(errorMessage(error)))$('launcher-version-notice').hidden=false;});
void load().then(() => { if(launchOptions.get('connect')==='1')void connectWallet();else void restoreConnectedWallet(); if (launchOptions.get('add') === '1' || (hosts.length && !rows.length && launchOptions.get('add') !== '0')) openAdd(); });
setInterval(()=>{if(!document.hidden){void loadMonitor();void load();if(!txBusy){void loadChain(true);if(wallet)void loadOwnerRequests(true);if(lookupWallet)void loadWalletNodes(true);}}},6000);

$('share-server').onclick = async () => {
 $('share-dialog').showModal();$('share-link').value='';$('share-error').textContent='';$('copy-share').disabled=true;$('share-status').textContent='Opening an encrypted Grph P2P endpoint…';
 try { const data=await api('/share','POST',{});$('share-link').value=data.link;$('copy-share').disabled=false;$('share-status').textContent='Paste this link into Connect a server on your other computer. Keep this launcher running.'; }
 catch(error){$('share-status').textContent='';$('share-error').textContent=errorMessage(error);}
};
$('copy-share').onclick = async () => { try {await navigator.clipboard.writeText($('share-link').value);$('share-status').textContent='Private connection link copied.';} catch {$('share-link').focus();$('share-link').select();$('share-status').textContent='Copy the selected private link.';} };
$('share-dialog').addEventListener('close',()=>{$('share-link').value='';});
