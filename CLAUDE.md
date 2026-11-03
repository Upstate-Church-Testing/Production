# Notes for Claude

- **Every SQL call against the live database** (execute_sql or apply_migration)
  starts with `select set_config('app.actor', 'Claude', true);` so history and the
  item and model stamps show "Claude" instead of "Someone". See README › Changes Claude makes.
- Publish: run `python3 tools/stamp.py`, commit, push to `main` (GitHub Pages).
