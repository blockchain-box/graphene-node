import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
export async function runHostDoctor() {
 let output;
 try {output=(await execute(process.execPath,[fileURLToPath(new URL('./operator-doctor.js',import.meta.url)),'--json'],{cwd:fileURLToPath(new URL('../',import.meta.url)),timeout:50000,maxBuffer:65536,windowsHide:true})).stdout;}
 catch(error){output=error.stdout;if(!output)throw new Error('Doctor did not finish. Check Docker access on this host and try again.');}
 try {const report=JSON.parse(output);if(!Array.isArray(report.checks)||typeof report.ok!=='boolean')throw new Error();return report;}
 catch{throw new Error('Doctor returned an unreadable report. Run npm run doctor in the launcher folder to inspect the host.');}
}
