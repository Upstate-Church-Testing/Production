#!/usr/bin/env python3
"""Stamps a new version before publishing.

Every copy of the app checks version.json and reloads itself when it changes,
and the import map makes browsers fetch the new copy of each script file.
Run from the repository root: python3 tools/stamp.py
"""
import json, pathlib, re, time

root = pathlib.Path(__file__).resolve().parent.parent
v = time.strftime('%Y%m%d%H%M%S', time.gmtime())

modules = sorted(p.relative_to(root).as_posix() for p in (root / 'js').rglob('*.js'))
imports = {f'./{m}': f'./{m}?v={v}' for m in modules if m != 'js/app.js'}

html = (root / 'index.html').read_text()
html = re.sub(r'(styles\.css|js/app\.js)\?v=[\w]+', lambda m: f'{m.group(1)}?v={v}', html)
html = re.sub(r'(<!-- versions:start.*?-->\n).*?(\s*<!-- versions:end -->)',
              lambda m: m.group(1) + '  <script type="importmap">' + json.dumps({'imports': imports}, separators=(',', ':')) + '</script>' + m.group(2),
              html, flags=re.S)
(root / 'index.html').write_text(html)
(root / 'version.json').write_text(json.dumps({'v': v}) + '\n')
print(v)
