#!/usr/bin/env python3
"""Build and verify the scoped local Engineering app candidate; never activate it."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
RELEASE = Path('/Users/jamesau0723/Library/Application Support/Agents Chat Operations/releases/heytracki-mission-recovery-20261121')
BASE = 'sha256:eca2db282d334ffa46c273558972b8c202f12b282c458733b2c7d5e14c443bb7'
BASE_REV = '4122e298a6572f271f7af93439c689d11259a14b'
RUNNER_SHA = 'cea9a0f82e544e0c6bcc84746c6de2ae09e0eae17b916227b9d43b9a392dd8f4'
DOCKER = ['/opt/homebrew/bin/docker', '--context', 'colima-agentes-chat-local']
BUN = '/Users/jamesau0723/Documents/Codex/2026-11-12/https-github-com-dev-james0723-agentes/work/agentes-runner/runtime/bun'
LIVE = 'agentes-chat-local-agentes-1'
SOURCE_URL = 'https://github.com/dev-james0723/agentes-chat'

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def output(args, cwd=REPO):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def verify_candidate_image(image_id, revision, source_digest):
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id), 'Candidate ID is not immutable')
    candidate, base = json.loads(output(DOCKER + ['image', 'inspect', image_id, BASE]))
    require(candidate['Id'] == image_id and base['Id'] == BASE, 'Docker image identity mismatch')
    candidate_fs, base_fs = candidate['RootFS'], base['RootFS']
    base_layers, candidate_layers = base_fs['Layers'], candidate_fs['Layers']
    require(candidate_fs['Type'] == base_fs['Type'] == 'layers'
            and base_layers and len(candidate_layers) > len(base_layers)
            and candidate_layers[:len(base_layers)] == base_layers,
            'Candidate does not extend the immutable BASE image layers')
    labels = candidate['Config']['Labels'] or {}
    require(labels.get('org.opencontainers.image.revision') == revision
            and labels.get('org.opencontainers.image.source') == SOURCE_URL
            and labels.get('chat.agentes.source-digest') == source_digest,
            'Candidate OCI provenance labels do not match the reviewed source')

def write_receipt(path, receipt):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            json.dump(receipt, file, indent=2)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.link(name, path)
    finally:
        os.unlink(name)

def scoped(path):
    p = path.split('/')
    if len(p) == 1:
        return path in ('package.json', 'bun.lock')
    if p[0] not in ('apps', 'packages') or any((x in ('node_modules', 'dist', '.turbo', 'coverage') for x in p)):
        return False
    return len(p) == 3 and p[2] == 'package.json' or (len(p) >= 4 and (p[2] == 'src' or p[:3] == ['apps', 'server', 'runner'] or p[:3] == ['packages', 'db', 'migrations']))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revision', required=True)
    args = ap.parse_args()
    head = output(['git', 'rev-parse', args.revision])
    require(head == output(['git', 'rev-parse', 'HEAD']), 'The intended revision moved')
    require(not output(['git', 'status', '--porcelain']), 'Commit/reconcile worktree changes first')
    require(output(DOCKER + ['inspect', LIVE, '--format', '{{.Image}}']) == BASE, 'Live image changed')
    subprocess.run(['git', 'merge-base', '--is-ancestor', BASE_REV, head], cwd=REPO, check=True)
    expected_revision = json.loads(output([BUN, 'scripts/runtime-identity.ts', 'rev', head]))
    expected = {key: expected_revision[key] for key in ('digest', 'files')}
    RELEASE.mkdir(mode=448, parents=True, exist_ok=True)
    context = RELEASE / ('image-' + head[:12])
    require(not context.exists(), 'Context exists; inspect prior effect/receipt before retrying')
    context.mkdir(mode=448)
    with (context / 'web-build.log').open('w') as log:
        subprocess.run(['/opt/homebrew/bin/node', 'node_modules/vite/bin/vite.js', 'build'], cwd=REPO / 'apps/web', stdout=log, stderr=subprocess.STDOUT, check=True)
    require(head == output(['git', 'rev-parse', 'HEAD']) and (not output(['git', 'status', '--porcelain'])), 'Source changed while building')
    changes = output(['git', 'diff', '--name-status', BASE_REV, head]).splitlines()
    paths = []
    for item in changes:
        status, *names = item.split('\t')
        if not any((scoped(name) for name in names)):
            continue
        require(status in ('M', 'A'), 'Unsupported runtime rename/delete: ' + item)
        paths.append(names[-1])
    require('packages/engine/src/missions.ts' in paths and 'apps/web/src/components/missions/MissionCards.tsx' in paths, 'Required recovery implementation missing')
    overlay = context / 'overlay'
    for name in paths:
        require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'Required deployment invariant failed')
        src = REPO / name
        require(src.is_file() and (not src.is_symlink()), 'Non-regular runtime source: ' + name)
        dst = overlay / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    dist = REPO / 'apps/web/dist'
    require((dist / 'index.html').is_file(), 'Required deployment invariant failed')
    assets = {}
    for src in sorted(dist.rglob('*')):
        require(not src.is_symlink(), 'Unexpected build symlink')
        if src.is_file():
            name = src.relative_to(dist).as_posix()
            digest = hashlib.sha256(src.read_bytes()).hexdigest()
            if name == 'runner/agentes-runner.mjs':
                require(digest == RUNNER_SHA, 'Build unexpectedly changed distributed runner')
            assets[name] = digest
    shutil.copytree(dist, overlay / 'apps/web/dist')
    manifest_bytes = json.dumps(assets, sort_keys=True).encode()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    (context / 'assets.json').write_bytes(manifest_bytes)
    base_tag = 'agentes-heytracki-recovery-base:eca2db282d33'
    tag = 'agentes-chat-local:heytracki-mission-recovery-' + head[:12]
    (context / 'Dockerfile').write_text(f'''FROM {base_tag}\nCOPY ["overlay/", "/app/"]\nCOPY ["assets.json", "/tmp/heytracki-release-assets.json"]\nLABEL org.opencontainers.image.revision="{head}" org.opencontainers.image.source="{SOURCE_URL}" chat.agentes.source-digest="{expected['digest']}"\n''')
    subprocess.run(DOCKER + ['tag', BASE, base_tag], check=True)
    require(output(DOCKER + ['image', 'inspect', base_tag, '--format', '{{.Id}}']) == BASE, 'Required deployment invariant failed')
    with (context / 'build.log').open('w') as log:
        subprocess.run(DOCKER + ['build', '--pull=false', '--network=none', '-t', tag, str(context)], stdout=log, stderr=subprocess.STDOUT, check=True)
    image_id = output(DOCKER + ['image', 'inspect', tag, '--format', '{{.Id}}'])
    verify_candidate_image(image_id, head, expected['digest'])
    js = 'import {runningSourceIdentity} from "./apps/server/src/source-identity.ts"; console.log(JSON.stringify(await runningSourceIdentity()()));'
    actual = json.loads(output(DOCKER + ['run', '--rm', '--network=none', '-w', '/app', '--entrypoint', 'bun', image_id, '-e', js]))
    require(actual == expected, f'Source mismatch: {actual} != {expected}')
    verify_js = """
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifestPath = '/tmp/heytracki-release-assets.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const mismatches = Object.entries(manifest)
  .filter(([p, h]) => digest('/app/apps/web/dist/' + p) !== h).map(([p]) => p);
console.log(JSON.stringify({
  count: Object.keys(manifest).length, mismatches, manifestSha256: digest(manifestPath),
  runner: digest('/app/apps/web/dist/runner/agentes-runner.mjs')
}));
"""
    assets_verified = json.loads(output(DOCKER + ['run', '--rm', '--network=none', '--entrypoint', 'bun', image_id, '-e', verify_js]))
    require(not assets_verified['mismatches'] and assets_verified['runner'] == RUNNER_SHA
            and assets_verified['count'] == len(assets)
            and assets_verified['manifestSha256'] == manifest_sha, 'Candidate asset or manifest verification failed')
    require(output(DOCKER + ['inspect', LIVE, '--format', '{{.Image}}']) == BASE, 'Live installation changed during candidate build')
    receipt = dict(builtAt=datetime.now(timezone.utc).isoformat(), revision=head, tag=tag, imageId=image_id, baseImageId=BASE, baseRevision=BASE_REV, expectedSource=expected, isolatedImageSource=actual, sourceVerified=True, copiedPaths=paths, assetCount=len(assets), assetsVerified=assets_verified, context=str(context), runningInstallationChanged=False)
    receipt_path = RELEASE / ('image-receipt-' + head[:12] + '.json')
    write_receipt(receipt_path, receipt)
    print(json.dumps({'receipt': str(receipt_path), 'revision': head, 'imageId': image_id, 'source': actual, 'assets': len(assets), 'runnerPreserved': True}))
if __name__ == '__main__':
    main()
