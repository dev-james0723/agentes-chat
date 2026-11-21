#!/usr/bin/env python3
"""Scoped local app activation and explicit post-activation verification/rollback."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

RUNTIME = Path('/Users/jamesau0723/Documents/Codex/2026-11-12/https-github-com-dev-james0723-agentes/work/agentes-runtime')
BASE = 'sha256:eca2db282d334ffa46c273558972b8c202f12b282c458733b2c7d5e14c443bb7'
BASE_SOURCE = {'digest':'sha256:d082298a5c8a2380a319d99fc711c8a138bff6392d010f5e61f32b8816bbee35','files':3306}
RUNNER_SHA = 'cea9a0f82e544e0c6bcc84746c6de2ae09e0eae17b916227b9d43b9a392dd8f4'
DOCKER = ['/opt/homebrew/bin/docker','--context','colima-agentes-chat-local']
PROJECT = 'agentes-chat-local'
SERVICE = 'agentes'
LIVE = f'{PROJECT}-{SERVICE}-1'
SOURCE_URL = 'https://github.com/dev-james0723/agentes-chat'
HTTP_ORIGIN = 'http://localhost:3000'
RO_QUERY = '/Users/jamesau0723/Projects/engineering-os-docs/docs/engineering-os-audit/2026-11-14/tools/agentes-ro-query.sh'
IMAGE_LINE = re.compile(rb'(?m)^([ \t]*AGENTES_IMAGE[ \t]*=)([^\r\n]*)')
ENV_KEYS = re.compile(rb'(?m)^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=')

def require(condition, message):
    if not condition: raise RuntimeError(message)
def now():
    return datetime.now(timezone.utc).isoformat()
def output(args, **kwargs):
    return subprocess.check_output(args,text=True,**kwargs).strip()

def private_write(path,data,exclusive=False):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        if exclusive:
            os.link(name, path)
        else:
            os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)

def write_json(path,value,exclusive=False):
    private_write(path,(json.dumps(value,indent=2)+'\n').encode(),exclusive)

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

def image_value(data):
    matches=list(IMAGE_LINE.finditer(data))
    require(len(matches)==1,'Expected exactly one image-selection key')
    return matches[0].group(2)
def replace_image(data,value):
    require(b'\n' not in value and b'\r' not in value,'Invalid image value')
    image_value(data)
    return IMAGE_LINE.sub(lambda m:m.group(1)+value,data)
def cas_image(expected_bytes,new_bytes,token):
    env=RUNTIME/'.env'
    require(env.read_bytes()==expected_bytes,'Deployment environment changed; reconcile')
    require(replace_image(expected_bytes,b'')==replace_image(new_bytes,b''),'Unrelated environment mutation')
    temp=RUNTIME/('.env.heytracki-'+token)
    private_write(temp,new_bytes,True)
    try:
        require(env.read_bytes()==expected_bytes,'Deployment environment changed during staging')
        os.replace(temp,env)
    finally:
        if temp.exists(): temp.unlink()
def idle():
    query="""SELECT json_build_object(
'executingRuns',(SELECT count(*) FROM agent_runs WHERE status NOT IN ('done','failed','canceled','waiting_input')),
'waitingInput',(SELECT count(*) FROM agent_runs WHERE status='waiting_input'),
'machineWork',(SELECT count(*) FROM machine_tasks WHERE ended_at IS NULL AND status IN ('queued','running','interrupted')));"""
    value=json.loads(output([RO_QUERY,query]))
    require(value['executingRuns']==0 and value['machineWork']==0,'Live execution appeared; wait for a safe cutover')
    return value
def compose_config(expected_env):
    config_path = RUNTIME / 'docker-compose.yml'
    env_path = RUNTIME / '.env'
    require(env_path.read_bytes() == expected_env, 'Deployment environment changed before Compose resolution')
    command = ['/opt/homebrew/bin/docker-compose', '--project-directory', str(RUNTIME), '-p', PROJECT,
               '-f', str(config_path), '--env-file', str(env_path)]
    file_keys = {key.decode() for key in ENV_KEYS.findall(expected_env)}
    env = {key: value for key, value in os.environ.items() if key not in file_keys and key != 'AGENTES_IMAGE'}
    env['DOCKER_CONTEXT'] = 'colima-agentes-chat-local'
    env.pop('COMPOSE_COMPATIBILITY', None)
    env['COMPOSE_REMOVE_ORPHANS'] = '0'
    result = subprocess.run(command + ['config', '--format', 'json'], env=env, text=True, capture_output=True)
    require(result.returncode == 0, 'Unable to resolve the scoped Compose configuration')
    config = json.loads(result.stdout)
    service = config.get('services', {}).get(SERVICE)
    require(config.get('name') == PROJECT and service is not None
            and service.get('container_name', LIVE) == LIVE
            and service.get('scale', 1) == 1
            and service.get('deploy', {}).get('replicas', 1) == 1,
            'Compose configuration does not target the exact app service')
    image = subprocess.run(DOCKER + ['image', 'inspect', service['image'], '--format', '{{.Id}}'],
                           text=True, capture_output=True)
    require(image.returncode == 0, 'Unable to resolve the scoped Compose image')
    require(env_path.read_bytes() == expected_env, 'Deployment environment changed during Compose resolution')
    return command, env, image.stdout.strip()

def inspect_app_container(name, allow_missing=False):
    fields = '{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}\n{{json .State.Running}}'
    result = subprocess.run(DOCKER + ['container', 'inspect', '--format', fields, name],
                            text=True, capture_output=True)
    if result.returncode != 0:
        missing = {f'Error: No such container: {name}', f'Error: No such object: {name}'}
        if allow_missing and result.returncode == 1 and not result.stdout.strip() and result.stderr.strip() in missing:
            return None
        raise RuntimeError('Unable to inspect the scoped Docker app container')
    actual_name, image_id, labels, running = map(json.loads, result.stdout.splitlines())
    labels = labels or {}
    require(actual_name == '/' + name
            and labels.get('com.docker.compose.project') == PROJECT
            and labels.get('com.docker.compose.service') == SERVICE
            and labels.get('com.docker.compose.project.working_dir') == str(RUNTIME)
            and labels.get('com.docker.compose.project.config_files') == str(RUNTIME / 'docker-compose.yml')
            and labels.get('com.docker.compose.oneoff', '').lower() == 'false',
            'Unexpected Docker app container name or Compose labels')
    return image_id, running

def check_app_containers(allowed_images, require_running=False):
    named = inspect_app_container(LIVE, allow_missing=not require_running)
    if named is not None:
        image_id, running = named
        require(image_id in allowed_images, 'Another release owns the named app container')
        require(not require_running or running is True, 'Expected the baseline app to be running')
    names = output(DOCKER + ['container', 'ls', '--all', '--format', '{{.Names}}',
                             '--filter', 'label=com.docker.compose.project=' + PROJECT,
                             '--filter', 'label=com.docker.compose.service=' + SERVICE])
    for name in names.splitlines():
        if name == LIVE:
            require(named is not None, 'Named app container changed during inspection')
        else:
            image_id, _ = inspect_app_container(name)
            require(image_id in allowed_images, 'Another release owns a container in the app service')

def compose(log_path, expected_env, expected_image, allowed_images, before_up, require_running=False):
    command, env, resolved = compose_config(expected_env)
    require(resolved == expected_image, 'Effective Compose image differs from reviewed immutable image')
    check_app_containers(allowed_images, require_running)
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'wb') as log:
        activity = idle()
        require((RUNTIME / '.env').read_bytes() == expected_env, 'Deployment environment changed before Compose up')
        before_up(activity)
        subprocess.run(command + ['up', '-d', '--no-deps', SERVICE], env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    return activity
def health(expected,image_id):
    deadline=time.monotonic()+55
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen('http://localhost:3000/api/health',timeout=3) as r: value=json.load(r)
            if value.get('status')=='ok' and value.get('database')=='ok' and value.get('source')==expected:
                require(output(DOCKER+['inspect',LIVE,'--format','{{.Image}}'])==image_id,'Live image mismatch')
                return value
        except (OSError,ValueError,RuntimeError,subprocess.CalledProcessError): pass
        time.sleep(1)
    raise RuntimeError('Matching app health/source/image did not become ready')
class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            url = attrs.get('src')
        elif tag == 'link' and {'stylesheet', 'modulepreload', 'preload'} & set((attrs.get('rel') or '').lower().split()):
            url = attrs.get('href')
        else:
            return
        if not url:
            return
        parsed = urllib.parse.urlsplit(url)
        if not parsed.path.lower().endswith(('.js', '.mjs', '.css')):
            return
        require(url == parsed.path and parsed.path.startswith('/assets/'), 'Unexpected entry asset URL in the app index')
        self.paths.add(parsed.path)

def entry_assets(html):
    parser = EntryAssets()
    parser.feed(html.decode('utf-8'))
    parser.close()
    require(parser.paths, 'No JS or CSS entry assets found in the app index')
    return parser.paths

def served_bytes(path):
    url = HTTP_ORIGIN + path
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=15) as response:
        require(response.status == 200 and response.geturl() == url, 'Unexpected app asset response')
        return response.read()

def verify_assets(image):
    context = Path(image['context'])
    manifest_bytes = (context / 'assets.json').read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == image['assetsVerified']['manifestSha256'],
            'Candidate asset manifest changed after isolated image verification')
    manifest = json.loads(manifest_bytes)
    index = (context / 'overlay/apps/web/dist/index.html').read_bytes()
    require(hashlib.sha256(index).hexdigest() == manifest['index.html'], 'Compiled candidate index does not match the manifest')
    served_index = served_bytes('/')
    paths = sorted(entry_assets(served_index))
    require(set(paths) == entry_assets(index), 'Served HTML entry paths differ from the compiled candidate index')
    index_sha = hashlib.sha256(served_index).hexdigest()
    require(index_sha == manifest['index.html'], 'Served HTML index does not match the candidate manifest')
    for path in paths:
        data = served_bytes(path)
        require(hashlib.sha256(data).hexdigest() == manifest.get(path.lstrip('/')), 'Served entry asset mismatch: ' + path)
    runner=output(DOCKER+['exec',LIVE,'bun','-e',"import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync('/app/apps/web/dist/runner/agentes-runner.mjs')).digest('hex'));"])
    require(runner==RUNNER_SHA,'Distributed runner changed')
    return {'servedEntryAssets': paths, 'servedIndexSha256': index_sha, 'runnerPreserved': True}

def rollback(image, record, receipt_path, token):
    allowed_images = (BASE, image['imageId'])
    current = (RUNTIME / '.env').read_bytes()
    selector = image_value(current)
    require(selector in tuple(value.encode() for value in allowed_images), 'Image selection changed outside this release')
    require(compose_config(current)[2].encode() == selector, 'Effective Compose image does not match the current selector')
    check_app_containers(allowed_images)
    restored = replace_image(current, BASE.encode())
    record['state'] = 'rollback-staging'
    write_json(receipt_path, record)
    cas_image(current, restored, token + '-rollback')
    record['state'] = 'rollback-staged'
    write_json(receipt_path, record)

    def before_up(activity):
        record.update(state='rollback-recreate-starting', rollbackActivity=activity)
        write_json(receipt_path, record)

    compose(receipt_path.with_name('rollback-' + image['revision'][:12] + '.log'),
            restored, BASE, allowed_images, before_up)
    record['rollbackHealth'] = health(BASE_SOURCE, BASE)
    record.update(state='rolled-back', rollbackVerifiedAt=now())

def restore_before_recreate(image, original, token):
    check_app_containers((BASE,), require_running=True)
    current = (RUNTIME / '.env').read_bytes()
    original_selector = image_value(original)
    selector = image_value(current)
    require(selector in (image['imageId'].encode(), original_selector),
            'Image selection changed while aborting before recreation')
    if selector != original_selector:
        cas_image(current, replace_image(current, original_selector), token + '-abort')

def activate(image, record, receipt_path, token):
    original = None
    up_attempted = False

    def before_up(activity):
        nonlocal up_attempted
        record.update(state='recreate-starting', activityBefore=activity)
        write_json(receipt_path, record)
        up_attempted = True

    try:
        check_app_containers((BASE,), require_running=True)
        record['healthBefore'] = health(BASE_SOURCE, BASE)
        current = (RUNTIME / '.env').read_bytes()
        require(compose_config(current)[2] == BASE, 'Current deployment selection changed')
        private_write(receipt_path.with_name('runtime-env-before-' + image['revision'][:12]), current, True)
        record['originalEnvironmentSha256'] = hashlib.sha256(current).hexdigest()
        record['environmentKeysChanged'] = ['AGENTES_IMAGE']
        record['state'] = 'staging-environment'
        write_json(receipt_path, record)
        original = current
        staged = replace_image(original, image['imageId'].encode())
        cas_image(original, staged, token)
        record['state'] = 'environment-staged'
        write_json(receipt_path, record)
        compose(receipt_path.with_suffix('.log'), staged, image['imageId'], (BASE,), before_up, require_running=True)
        record['state'] = 'started'
        write_json(receipt_path, record)
        record['health'] = health(image['expectedSource'], image['imageId'])
        record['assetVerification'] = verify_assets(image)
        record.update(state='activated-awaiting-ui', activatedAt=now(),
                      otherServicesChanged=False, runnerConfigurationChanged=False)
    except BaseException as error:
        record.update(failedAt=now(), errorClass=type(error).__name__)
        if up_attempted:
            try:
                rollback(image, record, receipt_path, token)
            except BaseException as rollback_error:
                record.update(state='rollback-required', rollbackErrorClass=type(rollback_error).__name__)
        elif original is not None:
            try:
                restore_before_recreate(image, original, token)
                record['state'] = 'aborted-before-recreate'
            except BaseException as restore_error:
                record.update(state='pre-recreate-restore-required', restoreErrorClass=type(restore_error).__name__)
        else:
            record['state'] = 'failed'
        raise

def finalize(image, record, receipt_path, verification, token):
    try:
        require(record.get('state') in ('activated-awaiting-ui', 'verified'), 'Activation is not awaiting native verification')
        require(verification is not None, 'Native verification receipt required')
        evidence = json.loads(verification.read_text())
        require(isinstance(evidence, dict) and evidence.get('revision') == image['revision']
                and evidence.get('imageId') == image['imageId'], 'UI evidence identity mismatch')
        require(all(evidence.get(key) is True for key in ('criticalUiVerified', 'runnerReconnectVerified', 'taskIdentityPreserved')),
                'Required native verification incomplete')
        verified = dict(record, health=health(image['expectedSource'], image['imageId']),
                        assetVerification=verify_assets(image), state='verified',
                        verifiedAt=now(), nativeVerification=str(verification))
        write_json(receipt_path, verified)
        return verified
    except BaseException as error:
        refusal = receipt_path.with_name(receipt_path.stem + '-finalize-refused-' + token + '.json')
        write_json(refusal, {'refusedAt': now(), 'previousState': record['state'], 'errorClass': type(error).__name__,
                             'revision': image['revision'], 'imageId': image['imageId']}, True)
        raise

def interrupted(signum, frame):
    raise KeyboardInterrupt('Termination requested')

def main():
    signal.signal(signal.SIGTERM, interrupted)
    parser=argparse.ArgumentParser()
    parser.add_argument('--receipt',required=True,type=Path)
    parser.add_argument('--expected-revision',required=True)
    group=parser.add_mutually_exclusive_group()
    group.add_argument('--activate',action='store_true')
    group.add_argument('--rollback',action='store_true')
    group.add_argument('--finalize',action='store_true')
    parser.add_argument('--verification',type=Path)
    args=parser.parse_args()
    image=json.loads(args.receipt.read_text())
    require(image['sourceVerified'] is True and image['baseImageId']==BASE
            and image['isolatedImageSource'] == image['expectedSource'], 'Unverified candidate/base')
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_revision), 'The reviewed revision must be a full Git SHA')
    require(image['revision']==args.expected_revision,'Receipt does not match reviewed revision')
    verify_candidate_image(image['imageId'], args.expected_revision, image['expectedSource']['digest'])
    release=args.receipt.parent
    receipt_path=release/('activation-'+image['revision'][:12]+'.json')
    if not (args.activate or args.rollback or args.finalize):
        check_app_containers((BASE,), require_running=True)
        require(compose_config((RUNTIME / '.env').read_bytes())[2] == BASE, 'Current deployment selection changed')
        print(json.dumps({'preflight':'ready','candidate':image['imageId'],'source':image['expectedSource'],'activity':idle(),'activationPerformed':False}))
        return
    token=str(uuid.uuid4())
    lock_path=RUNTIME/'.host-deployment.lock'
    lock={'protocol':'exclusive-create-json-owner-v1','pid':os.getpid(),'uid':os.getuid(),
          'writerThread':'heytracki-finish-20261121','releaseId':image['revision'],
          'purpose':'Scoped mission recovery release verification','createdAt':now(),'token':token}
    try:
        write_json(lock_path, lock, True)
        if args.activate:
            record = {'startedAt': now(), 'revision': image['revision'], 'imageId': image['imageId'], 'state': 'preflight'}
            write_json(receipt_path, record, True)
            try:
                activate(image, record, receipt_path, token)
            finally:
                write_json(receipt_path, record)
        else:
            record = json.loads(receipt_path.read_text())
            require(record.get('revision') == image['revision'] and record.get('imageId') == image['imageId'],
                    'Activation receipt identity mismatch')
            if args.rollback:
                try:
                    rollback(image, record, receipt_path, token)
                except BaseException as error:
                    record.update(state='rollback-required', rollbackFailedAt=now(),
                                  rollbackErrorClass=type(error).__name__)
                    raise
                finally:
                    write_json(receipt_path, record)
            else:
                record = finalize(image, record, receipt_path, args.verification, token)
    finally:
        try:
            current_lock = json.loads(lock_path.read_text())
        except (OSError, ValueError):
            current_lock = None
        if isinstance(current_lock, dict) and current_lock.get('token') == token:
            lock_path.unlink()
    print(json.dumps({'state':record['state'],'revision':image['revision'],'imageId':record['imageId']}))
if __name__=='__main__':
    main()
