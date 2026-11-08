"""Build a public development source kit from an explicit allowlist.

Maintainer tool (Python 3 + npm); generated kit users only need Node.js/npm.
No wallet, runtime, local configuration, node_modules or private identity is copied.
"""
import hashlib
import json
import pathlib
import shutil
import stat
import subprocess
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'dist/operator'


def selected_files():
    files = [ROOT / name for name in [
        'package.json', 'package-lock.json', '.dockerignore', 'README.md',
        'Join Graphene.command', 'Join Graphene.cmd',
        'Join Graphene Sentry.command', 'Join Graphene Sentry.cmd',
        'scripts/join-network.js',
        'scripts/node-identity.js', 'scripts/node-manager.js', 'scripts/node-wallet.js',
        'scripts/node-manager.html', 'scripts/node-manager-ui.js', 'scripts/node-diagnostics.js', 'scripts/node-monitor.js',
        'scripts/node-guide.js', 'scripts/node-guide-ui.js',
        'scripts/join-sentry.js', 'scripts/local-node-runtime.js',
        'scripts/operator-doctor.js',
        'scripts/update-cli.js',
        'scripts/update-e2e.js',
        'scripts/update-runtime.js',
        'scripts/checkpoint-core.js', 'scripts/checkpoint-docker.js',
        'scripts/checkpoint-storage.js', 'scripts/checkpoint-serving.js',
        'scripts/checkpoint-trust.js', 'scripts/checkpoint-enroll.js',
        'scripts/launcher-checkpoints.js', 'scripts/checkpoint-manager-ui.js',
    ]]
    files += sorted((ROOT / 'scripts/launcher-icons').glob('*.svg'))
    files += [ROOT / 'scripts/launcher-icons/LICENSE', ROOT / 'scripts/launcher-icons/LUCIDE_LICENSE', ROOT / 'scripts/launcher-assets/graphene-logo.png']
    files += sorted((ROOT / 'agents/lib').glob('*.js'))
    files += [ROOT / 'agents/lib/package.json']
    for role in ['validator', 'sentry']:
        base = ROOT / f'agents/{role}-agent'
        files += [base / 'package.json', base / 'Dockerfile', base / 'docker/entrypoint.sh']
        files += sorted((base / 'src').rglob('*.js'))
    for package in ['net', 'utils', 'server', 'client']:
        base = ROOT / 'network' / package
        files += [base / 'package.json', base / 'dist/index.js', base / 'dist/index.cjs']
        files += sorted((base / 'dist').glob('*.d.ts'))
        files += sorted((base / 'dist').glob('*.d.cts'))
    for file in files:
        if not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(ROOT):
            raise ValueError(f'Missing or unsafe kit input: {file.relative_to(ROOT)}')
    return sorted(set(files))


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='graphene-public-kit-') as temporary:
        staging = pathlib.Path(temporary) / 'graphene-operator-kit'
        for source in selected_files():
            target = staging / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        package_file = staging / 'package.json'
        package = json.loads(package_file.read_text())
        package['scripts'] = {key: value for key, value in package['scripts'].items()
                              if key in ['join', 'join:sentry', 'doctor', 'update', 'test:update:e2e', 'checkpoint:enroll']}
        package_file.write_text(json.dumps(package, indent=2) + '\n')
        # Refresh the staged lockfile for the kit's reduced package manifest.
        # Never run dependency lifecycle scripts while packaging.
        npm = shutil.which('npm.cmd' if __import__('os').name == 'nt' else 'npm')
        if not npm:
            raise RuntimeError('Install Node.js/npm before building the operator kit.')
        subprocess.run([npm, 'install', '--package-lock-only', '--ignore-scripts',
                        '--no-audit', '--no-fund'], cwd=staging, check=True)
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT))
        manifest = {
            'formatVersion': 1, 'channel': 'development-source', 'nodeMajor': 24,
            'chainId': 9876, 'sourceCommit': commit, 'workingTreeChanges': dirty,
            'signedInstaller': False, 'hostedProvisioning': False,
            'files': {str(p.relative_to(staging)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(staging.rglob('*')) if p.is_file()},
        }
        (staging / 'KIT_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
        archive = OUTPUT / 'graphene-operator-kit.zip'
        temporary_archive = archive.with_suffix('.zip.tmp')
        with zipfile.ZipFile(temporary_archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
            for file in sorted(staging.rglob('*')):
                if file.is_file():
                    info = zipfile.ZipInfo('graphene-operator-kit/' + str(file.relative_to(staging)))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (stat.S_IFREG | (file.stat().st_mode & 0o777)) << 16
                    zipped.writestr(info, file.read_bytes())
        temporary_archive.replace(archive)
        shutil.copy2(ROOT / 'README.md', OUTPUT / 'graphene-operator-guide.md')
        (OUTPUT / 'operator-kit.json').write_text(json.dumps({k: v for k, v in manifest.items() if k != 'files'}, indent=2) + '\n')
        checksums = []
        for filename in ['graphene-operator-kit.zip', 'graphene-operator-guide.md', 'operator-kit.json']:
            checksums.append(hashlib.sha256((OUTPUT / filename).read_bytes()).hexdigest() + '  ' + filename)
        (OUTPUT / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
        print(f'Public operator kit: {archive} ({archive.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
