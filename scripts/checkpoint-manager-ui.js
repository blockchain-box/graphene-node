/* Checkpoint controls use the authenticated manager on the selected node host. */
let checkpointView = null, checkpointPoll = null, checkpointSequence = 0, checkpointSubmitting = false, checkpointLoadError = false, checkpointConfirming = false;
let checkpointWalletSources = [], checkpointSourceWallet = null, checkpointSourceSequence = 0;

function checkpointSourceId(source, index) { return source.nodeId || 'unlinked-' + index; }
function checkpointHostId() { return $('checkpoint-host').value || 'local'; }
function checkpointDetails(value) {
  return `<dl><dt>Public manifest</dt><dd>${escapeHtml(value.manifestURL)}</dd><dt>Public enrollment</dt><dd>${escapeHtml(value.enrollmentURL)}</dd><dt>Publisher fingerprint</dt><dd>${escapeHtml(value.fingerprint)}</dd><dt>Canonical genesis hash</dt><dd>${escapeHtml(value.genesisHash)}</dd></dl>`;
}
function renderCheckpointControls() {
  const data = checkpointView;
  const busy = checkpointSubmitting || !data || data.job?.state === 'running';
  const enrolled = data?.enrollment?.state === 'configured';
  $('checkpoint-enroll-submit').disabled = busy || data?.enrollment?.state !== 'missing';
  $('checkpoint-create-submit').disabled = busy || !data?.creationAvailable || !wallet || !checkpointWalletSources.some(source => source.nodeId === $('checkpoint-source-node').value && source.canCreate);
  $('checkpoint-host').disabled = checkpointSubmitting;
  $('checkpoint-enrollment-status').textContent = !data ? 'Checking this host…' : enrolled ? `Enrolled with ${data.enrollment.manifestURL}. This trust is used when fresh nodes start on this host. Existing enrollment is preserved.` : data.enrollment?.error || 'No checkpoint provider is enrolled on this host.';
  $('checkpoint-enroll-form').hidden = !!data && data.enrollment?.state !== 'missing';
  $('checkpoint-create-form').hidden = !!data && !data.creationAvailable;
  $('checkpoint-create-help').textContent = !data ? 'Checking publisher support…' : data.creationAvailable ? 'Select an owned node on this host. Only synchronized nodes with zero voting power can be paused for capture. Serving sentries require confirmation of the interruption to validator connections. The publisher key stays on this host.' : 'Creation needs the full provider checkout with its isolated restore verifier. This operator kit supports enrollment.';
  $('checkpoint-publication').textContent = data?.publication?.state === 'verified' ? `Latest verified local checkpoint: block ${data.publication.height} · ${data.publication.createdAt}` : data?.publication?.error || '';
  const job = data?.job;
  $('checkpoint-job').textContent = checkpointSubmitting ? 'Submitting to the selected host…' : job ? `${job.kind === 'create' ? 'Creation' : 'Enrollment'}: ${job.phase}${job.error ? ' ' + job.error : ''}` : 'No checkpoint operation is running.';
  const published = job?.state === 'succeeded' && job.kind === 'create' ? job.result : data?.publisher?.state === 'configured' ? data.publisher : null;
  $('checkpoint-created-details').innerHTML = published ? `<p>Share these public values through a trusted channel. Make the complete publication tree available on the checkpoint host.</p>${checkpointDetails(published)}${published.stats ? `<p>Reused ${escapeHtml(published.stats.reusedChunks)} entries; created ${escapeHtml(published.stats.createdChunks)} compressed entries.</p>` : ''}` : '';
  if (!$('checkpoint-publication-url').value && data?.publisher?.manifestURL) $('checkpoint-publication-url').value = data.publisher.manifestURL;
  const source = checkpointWalletSources.find((source, index) => checkpointSourceId(source, index) === $('checkpoint-source-node').value);
  $('checkpoint-source-help').textContent = !wallet ? 'Connect your owner wallet to list its nodes.' : source ? `${source.name} · ${source.role} · ${source.state}${source.reason ? ' · ' + source.reason : ''}${source.interruptionRequired ? ' · Capture pauses this sentry and interrupts ' + source.activeValidatorCount + ' active validator connection(s). Explicit confirmation is required.' : ''}${source.interruptionRequired === undefined && /serving validators/.test(source.reason || '') ? ' Restart this host’s launcher from the updated folder to enable confirmed serving-sentry capture, then unlock the node again.' : ''}` : checkpointWalletSources.length && !checkpointWalletSources.some(source => source.canCreate) ? 'No node is ready to create a checkpoint. Select a node to see why, then refresh wallet nodes after resolving it.' : 'Select a node to review its readiness. Voting nodes cannot be paused for checkpoint creation.';
}
async function loadCheckpointWalletSources() {
  const host = checkpointHostId(), owner = wallet, sequence = ++checkpointSourceSequence, selectedSource = $('checkpoint-source-node').value;
  checkpointWalletSources = []; checkpointSourceWallet = owner;
  $('checkpoint-source-node').innerHTML = '<option value="">Loading wallet nodes…</option>';
  if (!owner) { $('checkpoint-source-node').innerHTML = '<option value="">Connect your owner wallet</option>'; renderCheckpointControls(); return; }
  try {
    const data = await api('/checkpoints/sources/' + owner, 'GET', undefined, host);
    if (sequence !== checkpointSourceSequence || host !== checkpointHostId() || owner !== wallet) return;
    checkpointWalletSources = data.nodes || [];
    $('checkpoint-source-node').innerHTML = '<option value="">Select a source node</option>' + checkpointWalletSources.map((source, index) => `<option value="${escapeHtml(checkpointSourceId(source, index))}">${escapeHtml(source.name)} · ${escapeHtml(source.role)}${source.canCreate ? source.interruptionRequired ? ' · Ready · Interrupts validator connections' : ' · Ready' : ' · ' + escapeHtml(source.reason)}</option>`).join('');
    if (checkpointWalletSources.some((source, index) => checkpointSourceId(source, index) === selectedSource)) $('checkpoint-source-node').value = selectedSource;
  } catch (error) { if (sequence === checkpointSourceSequence) $('checkpoint-manager-error').textContent = errorMessage(error); }
  renderCheckpointControls();
}
async function loadCheckpoints() {
  clearTimeout(checkpointPoll);
  const host = checkpointHostId(), sequence = ++checkpointSequence;
  try {
    const data = await api('/checkpoints', 'GET', undefined, host);
    if (sequence !== checkpointSequence || host !== checkpointHostId()) return;
    if (!data.enrollment || typeof data.creationAvailable !== 'boolean') throw new Error('Restart the selected host’s launcher to enable checkpoint controls.');
    checkpointView = data;
    if (checkpointLoadError) $('checkpoint-manager-error').textContent = '';
    checkpointLoadError = false;
  } catch (error) {
    if (sequence !== checkpointSequence || host !== checkpointHostId()) return;
    checkpointView = null;
    checkpointLoadError = true;
    $('checkpoint-manager-error').textContent = /not supported/i.test(errorMessage(error)) ? 'Restart the selected host’s launcher from the updated folder to enable checkpoint creation and enrollment.' : errorMessage(error);
  }
  renderCheckpointControls();
  if (checkpointSourceWallet !== wallet && $('checkpoint-dialog').open) void loadCheckpointWalletSources();
  if ($('checkpoint-dialog').open) checkpointPoll = setTimeout(loadCheckpoints, 2000);
}
function openCheckpointControls() {
  const host = current()?.hostId || (filter !== 'all' ? filter : 'local');
  $('checkpoint-host').innerHTML = hosts.filter(item => item.connected).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  $('checkpoint-host').value = hosts.some(item => item.id === host && item.connected) ? host : 'local';
  checkpointView = null;
  checkpointLoadError = false;
  $('checkpoint-manager-error').textContent = '';
  $('checkpoint-publication-url').value = '';
  $('checkpoint-dialog').showModal();
  renderCheckpointControls(); void loadCheckpoints(); void loadCheckpointWalletSources();
}
async function submitCheckpointAction(kind) {
  if (checkpointConfirming || checkpointSubmitting || !checkpointView || checkpointView.job?.state === 'running') return;
  const host = checkpointHostId();
  const source = checkpointWalletSources.find(source => source.nodeId === $('checkpoint-source-node').value && source.canCreate);
  if (kind === 'create' && (!source || !wallet)) { $('checkpoint-manager-error').textContent = 'Choose an eligible source node from your wallet.'; return; }
  if (kind === 'create') {
    const owner = wallet;
    checkpointConfirming = true;
    try {
      const interruption = source.interruptionRequired ? `\n\nThis sentry has ${source.activeValidatorCount} active validator connection(s). Capture will pause the sentry and interrupt those connections. Connected validators may lose network access and miss votes while it is paused. The sentry will be resumed before restore verification. Continue only if you accept this interruption.` : '';
      if (!await confirmLauncherAction(`Create a checkpoint from ${source.name} on ${hostLabel(host)}? Only this nonvoting node will pause briefly for capture. An isolated restore test follows. Uploads to a separate checkpoint host are not automatic.${interruption}`, { title: source.interruptionRequired ? 'Pause serving sentry & create?' : 'Create a checkpoint?', accept: source.interruptionRequired ? 'Pause sentry & create' : 'Create & verify', danger: !!source.interruptionRequired })) return;
    } finally { checkpointConfirming = false; }
    if (owner !== wallet || host !== checkpointHostId() || !checkpointView || checkpointView.job?.state === 'running' || !checkpointWalletSources.some(item => item.nodeId === source.nodeId && item.canCreate)) return;
  }
  const body = kind === 'create'
    ? { manifestURL: $('checkpoint-publication-url').value.trim(), confirmExport: true, ...(source.interruptionRequired ? { confirmServing: true } : {}), sourceNodeId: source.nodeId, wallet }
    : { url: $('checkpoint-enrollment-url').value.trim(), fingerprint: $('checkpoint-fingerprint').value.trim(), genesisHash: $('checkpoint-genesis').value.trim().toLowerCase() };
  checkpointSubmitting = true; renderCheckpointControls();
  try {
    const result = await api('/checkpoints/' + kind, 'POST', body, host);
    if (host === checkpointHostId()) checkpointView = { ...checkpointView, job: result.job };
    $('checkpoint-manager-error').textContent = '';
    if (kind === 'enroll') $('checkpoint-enroll-form').reset();
  } catch (error) { $('checkpoint-manager-error').textContent = errorMessage(error); }
  finally { checkpointSubmitting = false; renderCheckpointControls(); }
}
$('open-checkpoints').onclick = openCheckpointControls;
$('close-checkpoints').onclick = () => $('checkpoint-dialog').close();
$('checkpoint-host').onchange = () => { checkpointView = null; checkpointLoadError = false; $('checkpoint-manager-error').textContent = ''; $('checkpoint-publication-url').value = ''; $('checkpoint-enroll-form').reset(); renderCheckpointControls(); void loadCheckpoints(); void loadCheckpointWalletSources(); };
$('checkpoint-source-node').onchange = renderCheckpointControls;
$('checkpoint-refresh-sources').onclick = () => { void loadCheckpointWalletSources(); };
$('checkpoint-connect-wallet').onclick = async () => { await connectWallet(); void loadCheckpointWalletSources(); };
$('checkpoint-enroll-form').onsubmit = event => { event.preventDefault(); void submitCheckpointAction('enroll'); };
$('checkpoint-create-form').onsubmit = event => { event.preventDefault(); void submitCheckpointAction('create'); };
$('checkpoint-dialog').addEventListener('close', () => { clearTimeout(checkpointPoll); checkpointSequence++; });

let checkpointChoice = null, checkpointChoiceSequence = 0;
function checkpointChoiceDetails() {
  const choice = checkpointChoice?.choices?.get($('checkpoint-select-source').value);
  $('checkpoint-select-submit').disabled = !choice || !!checkpointChoice?.busy;
  $('checkpoint-select-details').textContent = choice ? `${choice.label}${choice.height ? ' · Block ' + choice.height : ''}${choice.createdAt ? ' · ' + choice.createdAt : ''}${choice.fingerprint ? ' · Publisher ' + choice.fingerprint : ''}${choice.genesisHash ? ' · Genesis ' + choice.genesisHash : ''}` : 'Select a checkpoint source to continue.';
}
async function loadCheckpointChoices() {
  const context = checkpointChoice, sequence = ++checkpointChoiceSequence;
  if (!context) return;
  context.choices = new Map(); $('checkpoint-select-submit').disabled = true;
  $('checkpoint-select-source').innerHTML = '<option value="">Loading checkpoint sources…</option>';
  $('checkpoint-select-error').textContent = '';
  try {
    const local = await api('/nodes/' + context.node.id + '/checkpoint-options/' + context.wallet, 'GET', undefined, context.node.hostId);
    if (context !== checkpointChoice || sequence !== checkpointChoiceSequence) return;
    let markup = '<option value="">Select a checkpoint source</option>';
    for (const provider of local.providers || []) {
      const id = 'provider:' + provider.id;
      const compatible = !local.genesisHash || provider.genesisHash === local.genesisHash;
      if (compatible) context.choices.set(id, { providerId: provider.id, label: provider.label, height: provider.checkpoint?.height, createdAt: provider.checkpoint?.createdAt, fingerprint: provider.fingerprint, genesisHash: provider.genesisHash });
      markup += `<option value="${escapeHtml(id)}" ${compatible ? '' : 'disabled'}>${escapeHtml(provider.label)}${provider.checkpoint?.height ? ' · Block ' + escapeHtml(provider.checkpoint.height) : ''}${compatible ? '' : ' · Different network'}</option>`;
    }
    const available = new Map(), failures = [];
    await Promise.all(hosts.filter(host => host.connected).map(async host => {
      try {
        const result = await api('/checkpoints/sources/' + context.wallet, 'GET', undefined, host.id);
        for (const node of result.nodes || []) {
          const key = node.agentAddress.toLowerCase();
          if (!available.has(key) || node.checkpoint && !available.get(key).node.checkpoint) available.set(key, { node, host });
        }
      } catch { failures.push(host.label); }
    }));
    if (context !== checkpointChoice || sequence !== checkpointChoiceSequence) return;
    for (const { node, host } of available.values()) {
      const source = node.checkpoint;
      const compatible = !!source && (!local.genesisHash || source.genesisHash === local.genesisHash);
      const id = 'node:' + host.id + ':' + node.agentAddress;
      const label = `${node.name} · ${node.role} · ${host.label}`;
      if (compatible) context.choices.set(id, { label, height: source.height, createdAt: source.createdAt, fingerprint: source.fingerprint, genesisHash: source.genesisHash, import: { url: source.enrollmentURL, fingerprint: source.fingerprint, genesisHash: source.genesisHash, sourceAgentAddress: node.agentAddress, sourceName: node.name.slice(0, 64) } });
      markup += `<option value="${escapeHtml(id)}" ${compatible ? '' : 'disabled'}>${escapeHtml(label)} · ${source ? compatible ? 'Block ' + escapeHtml(source.height) : 'Different network' : 'No fresh published checkpoint'}</option>`;
    }
    $('checkpoint-select-source').innerHTML = markup;
    if (failures.length) $('checkpoint-select-error').textContent = 'Could not list sources on: ' + failures.join(', ') + '. Connect or update those launchers to list their nodes.';
    if (!context.choices.size) $('checkpoint-select-error').textContent = 'No usable checkpoint is available. Create one from an eligible wallet node or enroll a provider on the target host, then refresh.';
  } catch (error) { if (context === checkpointChoice) $('checkpoint-select-error').textContent = errorMessage(error); }
  if (context === checkpointChoice) checkpointChoiceDetails();
}
async function chooseNodeCheckpoint(node, action) {
  const owner = wallet;
  const options = await api('/nodes/' + node.id + '/checkpoint-options/' + owner, 'GET', undefined, node.hostId);
  if (action === 'start' && !options.requiresCheckpoint) return undefined;
  if (checkpointChoice) throw new Error('Finish the current checkpoint selection first.');
  return new Promise(resolve => {
    checkpointChoice = { node, action, wallet: owner, choices: new Map(), resolve, busy: false };
    $('checkpoint-select-title').textContent = action === 'reset' ? 'Recover from a checkpoint' : 'Choose a checkpoint for first startup';
    $('checkpoint-select-target').textContent = `${node.name} · ${hostLabel(node.hostId)}. ${action === 'reset' ? 'Existing chain data will be backed up; identity and signing history are preserved.' : 'This fresh node will restore your selected checkpoint, then catch up.'}`;
    $('checkpoint-select-submit').textContent = action === 'reset' ? 'Recover & start' : 'Restore & start';
    $('checkpoint-select-dialog').showModal(); void loadCheckpointChoices();
  });
}
function cancelCheckpointChoice() {
  const context = checkpointChoice; checkpointChoice = null; checkpointChoiceSequence++;
  $('checkpoint-select-dialog').close(); context?.resolve(null);
}
async function confirmCheckpointChoice() {
  const context = checkpointChoice, choice = context?.choices.get($('checkpoint-select-source').value);
  if (!context || !choice || context.busy) return;
  context.busy = true; checkpointChoiceDetails();
  try {
    if (wallet !== context.wallet) throw new Error('The wallet changed. Cancel and choose the node again.');
    let providerId = choice.providerId;
    if (!providerId) {
      $('checkpoint-select-details').textContent = 'Verifying the selected node’s publisher, genesis and signed checkpoint…';
      const accepted = await api('/checkpoints/enroll-provider', 'POST', choice.import, context.node.hostId);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (checkpointChoice !== context) return;
        const status = await api('/checkpoints', 'GET', undefined, context.node.hostId);
        if (status.job?.id !== accepted.job.id) throw new Error('The host’s checkpoint operation changed. Refresh sources and try again.');
        if (status.job.state === 'failed') throw new Error(status.job.error || 'Checkpoint verification failed.');
        if (status.job.state === 'succeeded') { providerId = status.job.result.providerId; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!providerId) throw new Error('Verification is still running on the host. Wait for it to finish, then refresh sources.');
    }
    if (checkpointChoice !== context) return;
    if (wallet !== context.wallet) throw new Error('The wallet changed. Cancel and choose the node again.');
    checkpointChoice = null; checkpointChoiceSequence++; $('checkpoint-select-dialog').close(); context.resolve(providerId);
  } catch (error) {
    if (checkpointChoice === context) { $('checkpoint-select-error').textContent = errorMessage(error); context.busy = false; checkpointChoiceDetails(); }
  }
}
$('checkpoint-select-source').onchange = checkpointChoiceDetails;
$('checkpoint-select-refresh').onclick = () => { if (!checkpointChoice?.busy) void loadCheckpointChoices(); };
$('checkpoint-select-close').onclick = cancelCheckpointChoice;
$('checkpoint-select-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelCheckpointChoice(); });
$('checkpoint-select-submit').onclick = () => { void confirmCheckpointChoice(); };
