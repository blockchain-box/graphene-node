import test from 'node:test';
import assert from 'node:assert/strict';
import { syncProgress } from '../participant/ui/progress.js';

test('catch-up rate uses observed blocks and elapsed time', () => {
  assert.deepEqual(syncProgress({height:'100'}, {height:'300',catchingUp:true,primaryConnected:true}, 0, 40000),
    {blocksPerSecond:5,secondsPer100:20});
});

test('stale samples, disconnects and reset heights do not produce a replay estimate', () => {
  const current={height:'300',catchingUp:true,primaryConnected:true};
  for (const [previous, changed, start, end] of [
    [undefined,current,0,40000], [{height:'100'},current,undefined,40000], [{height:'100'},current,0,1000], [{height:'100'},current,0,301000],
    [{height:'400'},current,0,40000], [{height:'100'},{...current,primaryConnected:false},0,40000],
    [{height:'100'},{...current,catchingUp:false},0,40000], [{height:'100'},{...current,height:'9007199254740992'},0,40000],
  ]) assert.equal(syncProgress(previous,changed,start,end),null);
});
