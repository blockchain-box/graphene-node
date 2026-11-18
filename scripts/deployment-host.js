// Home-host operations. Linux keeps systemd; macOS uses the signed-in user's Docker Desktop.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const requireValue = (value, message) => { if (!value) throw new Error(message); };
export function homePlatform(platform, arch, osRelease = '') {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return 'macos';
  if (platform === 'linux' && arch === 'x64' && /^ID=ubuntu$/m.test(osRelease)) return 'ubuntu';
  throw new Error('Home installation supports Ubuntu x86-64 or macOS with Docker Desktop (Intel / Apple Silicon).');
}
export function macDocker({uid = process.getuid(), env = process.env, spawn = spawnSync, exists = fs.existsSync} = {}) {
  let binary = 'docker', prefix = [];
  if (uid === 0) {
    requireValue(env.SUDO_USER && /^\d+$/.test(env.SUDO_UID || '') && Number(env.SUDO_UID) > 0 && /^\d+$/.test(env.SUDO_GID || ''), 'Run the Mac installer as your normal Docker Desktop user, or with sudo from that user. A root login has no Docker Desktop context.');
    binary = '/usr/bin/sudo';
    const docker = ['/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/local/bin/docker'].find(exists);
    requireValue(docker, 'Install and open Docker Desktop on this Mac first.');
    prefix = ['-H', '-u', env.SUDO_USER, '--', docker];
  }
  return (args, directory, capture = false) => {
    const childEnv = {...env};
    for (const name of ['DOCKER_DEFAULT_PLATFORM','DOCKER_HOST','GRAPHENE_HOME_PASSPHRASE']) delete childEnv[name];
    const result = spawn(binary, [...prefix, ...args], {cwd:directory, env:childEnv, encoding:'utf8', stdio:capture ? 'pipe' : 'inherit'});
    requireValue(!result.error && result.status === 0, 'Docker Desktop command failed. Open Docker Desktop and check its current local context. For private registry images, sign in as your normal Mac user; for mount errors, share the validator directory in Docker Desktop Settings → Resources → File sharing.');
    return capture ? result.stdout.trim() : undefined;
  };
}
export function checkMacImages(compose, docker, bundle) {
  const info = JSON.parse(docker(['info','--format','{{json .}}'], bundle, true));
  const arch = {aarch64:'arm64',arm64:'arm64',x86_64:'amd64',amd64:'amd64'}[info.Architecture];
  requireValue(info.OSType === 'linux' && /docker desktop/i.test(info.OperatingSystem || '') && arch, 'Choose the local Docker Desktop Linux engine on this Mac. Remote Docker engines are not supported for home bind mounts.');
  const endpoint = docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'],bundle,true);
  requireValue(endpoint.startsWith('unix://'), 'Use the local Docker Desktop context, not a remote Docker endpoint.');
  for (const service of Object.values(compose.services)) {
    requireValue(!service.platform || service.platform === 'linux/'+arch || service.platform === 'linux/'+arch+'/v8', 'This home bundle forces a different CPU architecture. Download a native multi-platform release bundle.');
  }
  for (const image of new Set(Object.values(compose.services).map(service => service.image))) {
    requireValue(typeof image === 'string' && /@sha256:[a-f0-9]{64}$/.test(image), 'Home images must use immutable digests.');
    let actual;
    try { actual = docker(['image','inspect',image,'--format','{{.Os}}/{{.Architecture}}'], bundle, true); }
    catch {
      docker(['pull','--platform','linux/'+arch,image],bundle);
      actual = docker(['image','inspect',image,'--format','{{.Os}}/{{.Architecture}}'],bundle,true);
    }
    requireValue(actual === 'linux/'+arch, 'Release image '+image.split('@')[0]+' is '+actual+'; this Mac needs linux/'+arch+'. Build a new multi-platform release and prepare/download its Home bundle. Existing amd64-only releases cannot run natively on Apple Silicon.');
  }
  return arch;
}
export function macOwnership(directory, uid, gid) {
  requireValue(path.isAbsolute(directory) && directory !== '/' && Number.isInteger(uid) && uid > 0 && Number.isInteger(gid), 'Invalid Mac validator ownership request.');
  const parent = path.dirname(directory);
  // The original Linux-oriented default was initialized by root. Keep it private
  // while allowing the original Mac user / Docker Desktop to traverse it.
  if (parent === '/opt/graphene' && fs.lstatSync(parent).uid === 0) fs.chownSync(parent, uid, gid);
  function visit(file, top = false) {
    const entry = fs.lstatSync(file);
    requireValue(!entry.isSymbolicLink(), 'Validator directories must not contain symbolic links during Mac ownership setup.');
    if (entry.uid === 0) fs.chownSync(file, uid, gid);
    if (entry.isDirectory()) for (const name of fs.readdirSync(file)) {
      // Database container UIDs and permissions must survive subsequent installs.
      if (top && name === 'data') continue;
      visit(path.join(file,name));
    }
  }
  visit(directory, true);
}
