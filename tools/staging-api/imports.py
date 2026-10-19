#!/usr/bin/env python3
"""Prints the entrypoint and every local module it imports, transitively."""
import os, re, sys

IMPORT = re.compile(r"""(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
seen, todo = set(), [os.path.normpath(sys.argv[1])]
while todo:
    f = todo.pop()
    if f in seen:
        continue
    seen.add(f)
    for rel in IMPORT.findall(open(f, encoding="utf-8").read()):
        todo.append(os.path.normpath(os.path.join(os.path.dirname(f), rel)))
print("\n".join(sorted(seen)))
