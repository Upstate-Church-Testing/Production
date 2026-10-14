#!/usr/bin/env python3
"""Builds a single-file preview of the app with example data (no database).

Needs esbuild on PATH or ESBUILD set to its path.
Usage: python3 tools/build_preview.py OUTPUT.html
"""
import os, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1])
esbuild = os.environ.get('ESBUILD', 'esbuild')
js = subprocess.run([esbuild, str(root / 'js/app.js'), '--bundle', '--format=iife', '--target=es2020',
                     '--external:https://*', '--minify-syntax', '--log-level=warning'],
                    check=True, capture_output=True, text=True).stdout
css = (root / 'styles.css').read_text()
fonts = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Saira+Semi+Condensed:wght@600;700&display=swap'
page = f'''<title>Upstate Production</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
<style>
{css}
</style>
<div id="app"></div>
<script>window.UCP_PREVIEW = true;</script>
<script>
{js.replace('</script', '<\\/script')}
</script>
'''
out.write_text(page)
print(f'{out} {len(page)//1024} KB')
