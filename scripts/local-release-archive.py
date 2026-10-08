#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "release-local"
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VERSION = PACKAGE["version"]
STAMP = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
NAME = f"Plateform_local_RC_{VERSION}_{STAMP}.zip"
TARGET = OUT / NAME

EXCLUDED_DIRS = {
    ".git",
    ".supabase",
    ".local",
    "node_modules",
    "dist",
    "coverage",
    "test-results",
    "playwright-report",
    "backups",
    "release",
    "release-local",
    "__pycache__",
}
EXCLUDED_PREFIXES = {
    "tools/print-bridge/data/",
    "tools/print-bridge/tls/",
}
EXCLUDED_FILES = {
    "tools/print-bridge/config.json",
}


def allowed(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    if any(part in EXCLUDED_DIRS for part in path.relative_to(ROOT).parts[:-1]):
        return False
    if rel in EXCLUDED_FILES or any(rel.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
        return False
    name = path.name
    if name == ".env" or (name.startswith(".env.") and not name.endswith(".example")):
        return False
    if name.endswith((".log", ".tsbuildinfo", ".pem", ".key", ".p12", ".pfx")):
        return False
    return path.is_file()


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


files = sorted((path for path in ROOT.rglob("*") if allowed(path)), key=lambda p: p.relative_to(ROOT).as_posix())
if not files:
    raise SystemExit("No release files found")

manifest_files = [
    {
        "path": path.relative_to(ROOT).as_posix(),
        "size": path.stat().st_size,
        "sha256": digest(path),
    }
    for path in files
]
manifest = {
    "product": "Plateform",
    "kind": "LOCAL_RELEASE_CANDIDATE_SOURCE",
    "version": VERSION,
    "created_at": datetime.now(timezone.utc).isoformat(),
    "node_required": ">=24.13.0",
    "commercial_release_ready": False,
    "requires_local_full_gate": True,
    "files": manifest_files,
}

OUT.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(TARGET, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        archive.write(path, Path("Plateform") / path.relative_to(ROOT))
    archive.writestr(
        "Plateform/LOCAL_RC_MANIFEST.json",
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )

archive_sha = digest(TARGET)
sha_path = TARGET.with_suffix(TARGET.suffix + ".sha256")
sha_path.write_text(f"{archive_sha}  {TARGET.name}\n", encoding="utf-8")
print(json.dumps({"archive": str(TARGET), "sha256": archive_sha, "files": len(files)}, indent=2))
