"""Called only after check-release.mjs succeeds. Builds a source archive without secrets."""
import hashlib
import json
import re
import sys
import subprocess
import zipfile
from pathlib import Path

root = Path.cwd().resolve()
version = sys.argv[1] if len(sys.argv) == 2 else ''
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise SystemExit('Invalid release version')
subprocess.run(['node', 'scripts/check-release.mjs'], check=True)
evidence = json.loads((root / '.local/release/evidence.json').read_text())
if evidence.get('version') != version:
    raise SystemExit('Release version does not match reviewed evidence')
output = root / 'release' / f'Plateform-{version}.zip'
output.parent.mkdir(exist_ok=True)
excluded = {'node_modules', '.git', '.local', 'test-results', 'playwright-report', 'coverage', '.supabase', 'backups', 'release', '__pycache__'}
files = []
for path in sorted(root.rglob('*')):
    relative = path.relative_to(root)
    if any(part in excluded for part in relative.parts):
        continue
    if relative.parts[:2] == ('tools', 'print-bridge') and len(relative.parts)>2 and relative.parts[2] in {'data','tls'}:
        continue
    if path.is_symlink():
        raise SystemExit('Symlinks are not permitted in a release')
    if not path.is_file() or path.suffix in {'.log', '.tsbuildinfo', '.pem', '.key', '.p12', '.pfx'}:
        continue
    if path.name.startswith('.env') and not path.name.endswith('.example'):
        continue
    if 'STATO_CHECKPOINT' in path.name or (relative.parts[:2] == ('tools', 'print-bridge') and path.name == 'config.json'):
        continue
    files.append(path)
manifest = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        archive.write(path, f'Plateform-{version}/{path.relative_to(root)}')
    archive.writestr(f'Plateform-{version}/RELEASE_MANIFEST.json', json.dumps({'version': version, 'sha256': manifest}, indent=2))
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive integrity verification failed')
print(f'Release archive: {output}')
