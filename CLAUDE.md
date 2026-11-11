# Notes for Claude

- **Every SQL call against the live database** (execute_sql or apply_migration)
  starts with `select set_config('app.actor', 'Claude', true);` so history and the
  item and model stamps show "Claude" instead of "Someone". See README › Changes Claude makes.
- Publish: run `python3 tools/stamp.py`, commit, push to `main` (GitHub Pages).
- **Check the edges after any layout change**: nothing cut off at the bottom or sides, on
  phone sizes too. `python3 tools/edge_test.py` does it for Haze (serve the app on port 8777
  first); add a page to it when that page is made to fit the screen. It can't reproduce the
  installed iPhone app exactly, so say so and ask for a look on the real phone.
