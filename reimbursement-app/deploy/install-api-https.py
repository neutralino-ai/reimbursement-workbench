#!/usr/bin/env python3
"""Install only the authorized 29375 API ingress, with bounded rollback."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.request

if os.geteuid() != 0:
    raise SystemExit('Run as root')
source = Path(__file__).resolve().parent
environment = Path('/etc/reimbursement/server.env')
public_url = 'https://coop.neutrinophysics.cn:29375/reimbursement'
state = subprocess.check_output(['systemctl','show','nginx','-p','ActiveState','-p','UnitFileState'], text=True)
if 'ActiveState=inactive' not in state or 'UnitFileState=disabled' not in state:
    raise SystemExit('The original website service must remain stopped and disabled')
if Path('/etc/systemd/system/reimbursement-api.service').exists():
    raise SystemExit('API service already exists; inspect the installed version before updating')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 29376))

stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup_dir = Path('/etc/reimbursement') / ('before-https-29375-' + stamp)
backup_dir.mkdir(mode=0o700)
install_files = [
    ('nginx-api.conf', Path('/etc/reimbursement/nginx-api.conf'), 0o644),
    ('reimbursement-api.service', Path('/etc/systemd/system/reimbursement-api.service'), 0o644),
    ('reload-active-tls-services.sh', Path('/etc/letsencrypt/renewal-hooks/deploy/coop-bench-reload-nginx'), 0o755),
    ('reimbursement-api.logrotate', Path('/etc/logrotate.d/reimbursement-api'), 0o644),
]
targets = [environment] + [destination for _, destination, _ in install_files]
backups = {}
for index, target in enumerate(targets):
    if target.exists():
        backup = backup_dir / f'{index}-{target.name}'
        shutil.copy2(target, backup)
        backups[str(target)] = str(backup)
    else:
        backups[str(target)] = None
(backup_dir / 'manifest.json').write_text(json.dumps(backups, indent=2))

def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request('http://127.0.0.1:29376/reimbursement/api/auth/status', headers={'Host':'coop.neutrinophysics.cn:29375'})
    with opener.open(request, timeout=2) as response:
        assert response.status == 200 and json.load(response)['enabled'] is True

def tls_status(path, expected):
    result = subprocess.run(['curl','--noproxy','*','--connect-timeout','3','--max-time','5',
                             '--resolve','coop.neutrinophysics.cn:29375:127.0.0.1',
                             '-sS','-o','/dev/null','-w','%{http_code}',
                             f'https://coop.neutrinophysics.cn:29375{path}'], capture_output=True, text=True, check=True)
    if result.stdout != str(expected):
        raise RuntimeError(f'Unexpected HTTPS status {result.stdout} for {path}')
    return expected

try:
    original = environment.read_text()
    if len(re.findall(r'^PORT=\d+$', original, re.M)) != 1 or len(re.findall(r'^REIMBURSE_PUBLIC_URL=.*$', original, re.M)) != 1:
        raise RuntimeError('Unexpected environment file layout')
    revised = re.sub(r'^PORT=\d+$', 'PORT=29376', original, flags=re.M)
    revised = re.sub(r'^REIMBURSE_PUBLIC_URL=.*$', 'REIMBURSE_PUBLIC_URL=' + public_url, revised, flags=re.M)
    environment.write_text(revised)
    for name, destination, mode in install_files:
        shutil.copyfile(source / name, destination)
        os.chmod(destination, mode)
    # nginx -t creates its temporary subdirectories without binding any ports.
    Path('/run/reimbursement-api').mkdir(mode=0o755, exist_ok=True)
    Path('/var/log/reimbursement-api').mkdir(mode=0o750, exist_ok=True)
    subprocess.run(['nginx','-t','-c','/etc/reimbursement/nginx-api.conf'], check=True, capture_output=True)
    subprocess.run(['systemctl','daemon-reload'], check=True)
    subprocess.run(['systemctl','restart','reimbursement'], check=True)
    for attempt in range(20):
        try:
            health()
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(0.25)
    subprocess.run(['systemctl','enable','--now','reimbursement-api'], check=True, capture_output=True)
    for attempt in range(20):
        try:
            tls_status('/reimbursement/api/auth/status', 200)
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(0.25)
    tls_status('/reimbursement/api/workspace', 401)
    tls_status('/reimbursement/api/agent/catalog', 401)
    tls_status('/', 404)
    listeners = subprocess.check_output(['ss','-H','-lnt','( sport = :80 or sport = :443 )'], text=True)
    if listeners.strip():
        raise RuntimeError('Unexpected listener on 80 or 443')
except Exception:
    subprocess.run(['systemctl','disable','--now','reimbursement-api'], capture_output=True)
    for target, backup in backups.items():
        if backup:
            shutil.copy2(backup, target)
        else:
            Path(target).unlink(missing_ok=True)
    subprocess.run(['systemctl','daemon-reload'], check=False)
    subprocess.run(['systemctl','restart','reimbursement'], check=False)
    raise

print(json.dumps({'publicApiUrl':public_url, 'httpsPort':29375, 'internalBackend':'127.0.0.1:29376',
                  'localTLSVerified':True, 'anonymousWorkspaceStatus':401, 'anonymousAgentStatus':401,
                  'staticSiteStatus':404, 'ports80And443Closed':True, 'backupDirectory':str(backup_dir)}))
