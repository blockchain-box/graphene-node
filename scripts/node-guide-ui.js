/* Published checkpoint metadata is informational. Startup verifies the pinned signature separately. */
async function loadPublication() {
 const status = document.getElementById('checkpoint-status');
 try {
  const response = await fetch('/checkpoints/latest.json', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error();
  const {manifest:m,signature} = await response.json();
  if (!m || m.kind !== 'graphene-local-checkpoint' || m.chainId !== 9876 || !/^[a-zA-Z0-9-]{1,100}$/.test(m.id) || !/^\d+$/.test(m.height) || !Number.isFinite(Date.parse(m.createdAt)) || !m.verification?.caughtUp || !signature || Object.keys(m.files ?? {}).sort().join() !== ['app-state.json','genesis.json','mpt.tar.gz','tendermint.tar.gz'].join() || Object.values(m.files).some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<=0)) throw new Error();
  const age = Date.now()-Date.parse(m.createdAt);
  status.textContent = `Published checkpoint: block ${m.height} · ${new Date(m.createdAt).toLocaleString()} · ${(Object.values(m.files).reduce((total,f)=>total+f.bytes,0)/1024**2).toFixed(1)} MiB. ` + (age>86400000?'Older than the default 24-hour trust policy; ask for a fresh publication.':'Publisher-tested catch-up. Startup separately checks the pinned publisher signature, compatibility and restored application hash.');
  const link=document.createElement('a');link.href='/checkpoints/latest.json';link.download='latest.json';link.textContent='Download signed manifest';document.getElementById('checkpoint-publication').replaceChildren(link);
 } catch { status.textContent = 'No publisher-tested checkpoint is available from this launcher. The selected node host uses its provider-configured checkpoint source; ask your provider to confirm it before first start.'; }
}
void loadPublication();

// A private launcher link can include its access fragment.
// Keep it in this tab's session, never in a query string or a request body.
const access = location.hash.slice(1);
if (/^[a-f0-9]{64}$/i.test(access)) {
 try { sessionStorage.setItem('graphene-launcher-access', access); history.replaceState(null, '', location.pathname + location.search); }
 catch {
  document.querySelectorAll('a[href^="/?"]').forEach(a=>a.hash=access);
  document.querySelector('.guide-options').addEventListener('submit',event=>{event.preventDefault();const url=new URL(event.currentTarget.action);url.search=new URLSearchParams(new FormData(event.currentTarget)).toString();url.hash=access;location.assign(url.href);});
 }
}

// Reading progress is personal, scoped to this tab and guide choices. It never
// starts a node, verifies a registration, or changes a wallet transaction.
function initializeGuide() {
 const guide = document.querySelector?.('[data-guide-role]');
 if (!guide) return;
 const steps = [...guide.querySelectorAll('[data-guide-step]')];
 const ids = steps.map(step => step.id);
 const storageKey = 'graphene-guide-reviewed:' + guide.dataset.guideRole + ':' + guide.dataset.guideLocation;
 let reviewed = new Set();
 try { const saved=JSON.parse(sessionStorage.getItem(storageKey) || '[]'); if(Array.isArray(saved)) reviewed=new Set(saved.filter(id=>ids.includes(id))); } catch { /* Reading still works without browser storage. */ }
 const menu = document.getElementById('guide-menu');
 if (matchMedia('(max-width: 760px)').matches) menu.open=false;
 const announce = message => { document.getElementById('guide-announcement').textContent=message; };
 function selectNavigation(id) {
  guide.querySelectorAll('[data-guide-nav]').forEach(link=>{if(link.dataset.guideNav===id)link.setAttribute('aria-current',ids.includes(id)?'step':'location');else link.removeAttribute('aria-current');});
 }
 function openSection(id, reveal = true) {
  const section=document.getElementById(id);
  if (!section?.classList.contains('guide-section')) return false;
  if(ids.includes(id))steps.forEach(step=>{step.open=step.id===id;});else section.open=true;
  selectNavigation(id);
  if(reveal){section.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});section.querySelector('summary').focus({preventScroll:true});}
  return true;
 }
 function updateChecklist() {
  document.getElementById('guide-progress').value=reviewed.size;
  document.getElementById('guide-progress-label').textContent=reviewed.size+' of '+steps.length+' steps reviewed';
  document.getElementById('reset-guide').hidden=!reviewed.size;
  steps.forEach((step,index)=>{
   const done=reviewed.has(step.id);
   step.querySelector('.reviewed-label').hidden=!done;
   step.querySelector('[data-unreview-step]').hidden=!done;
   step.querySelector('[data-review-step]').textContent=done?(index===steps.length-1?'Reviewed':'Continue to next step'):(index===steps.length-1?'Mark reviewed':'Mark reviewed & continue');
   const link=guide.querySelector('[data-guide-nav="'+step.id+'"]');link.dataset.reviewed=String(done);
  });
 }
 function save() { try {sessionStorage.setItem(storageKey,JSON.stringify([...reviewed]));}catch{/* Keep the in-page checklist available. */} updateChecklist(); }
 guide.querySelectorAll('.step-actions').forEach(actions=>{actions.hidden=false;});
 guide.querySelectorAll('[data-review-step]').forEach(button=>button.onclick=()=>{
  const id=button.dataset.reviewStep;reviewed.add(id);save();
  const index=ids.indexOf(id),next=ids.slice(index+1).find(candidate=>!reviewed.has(candidate)) || ids.find(candidate=>!reviewed.has(candidate));
  if(next){openSection(next);history.replaceState(null,'','#'+next);announce('Instructions marked reviewed. Continue with the next step.');}
  else announce('All '+steps.length+' steps reviewed. Open Overview to check your node’s actual registration and live status.');
 });
 guide.querySelectorAll('[data-unreview-step]').forEach(button=>button.onclick=()=>{reviewed.delete(button.dataset.unreviewStep);save();announce('Step marked as unread.');});
 document.getElementById('reset-guide').onclick=()=>{reviewed.clear();save();openSection(ids[0]);history.replaceState(null,'','#'+ids[0]);announce('Reading checklist reset. Your nodes have not changed.');};
 steps.forEach(step=>step.addEventListener('toggle',()=>{if(step.open)selectNavigation(step.id);}));
 guide.querySelectorAll('[data-guide-nav]').forEach(link=>link.addEventListener('click',event=>{
  event.preventDefault();const id=link.dataset.guideNav;
  if(openSection(id)){history.replaceState(null,'','#'+id);if(matchMedia('(max-width: 760px)').matches)menu.open=false;}
 }));
 // Links from a setup step can open a reference without losing the current step.
 guide.querySelectorAll('.guide-section a[href^="#"], .help-quicklinks a[href^="#"]').forEach(link=>link.addEventListener('click',event=>{
  const id=link.getAttribute('href').slice(1);if(openSection(id)){event.preventDefault();history.replaceState(null,'','#'+id);}
 }));
 guide.querySelectorAll('[data-copy-command]').forEach(button=>{button.hidden=false;button.onclick=async()=>{
  const block=button.closest('.guide-command');
  try {await navigator.clipboard.writeText(block.querySelector('code').textContent);button.textContent='Copied';announce('Commands copied. Paste them into the terminal on the intended node host.');}
  catch {block.querySelector('pre').focus();announce('Copy is unavailable in this browser. Select the command text and copy it manually.');}
 };});
 updateChecklist();
 const fragment=location.hash.slice(1);
 if(fragment && openSection(fragment,false))requestAnimationFrame(()=>openSection(fragment));
 else openSection(ids.find(id=>!reviewed.has(id)) || ids[0],false);
 window.addEventListener('hashchange',()=>{openSection(location.hash.slice(1));});
}
initializeGuide();
