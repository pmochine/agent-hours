# vhs tape for the README hero GIF — render with: vhs docs/demo.tape
# Prereq: node /tmp/gen-demo-data.mjs (synthetic data, no real client data)
# A hidden PATH wrapper makes `npx agent-hours` resolve instantly to the
# local build (same code as published) — no download noise in the GIF.
Output docs/demo.gif

Set FontSize 15
Set Width 1100
Set Height 650
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `mkdir -p /tmp/bin && printf '#!/bin/sh\nexec node /Users/shadrix/Documents/Coding/my-projects/claude-hours-cli/dist/cli.js "$@"\n' > /tmp/bin/agent-hours && chmod +x /tmp/bin/agent-hours && export PATH=/tmp/bin:$PATH HOME=/tmp/ah-demo-home && cd ~/projects/acme-shop && clear`
Enter
Sleep 2s
Show

Sleep 800ms
Type "agent-hours --split"
Sleep 500ms
Enter
Sleep 5.5s

Hide
Type "clear"
Enter
Show
Type "agent-hours --by-day --split"
Sleep 500ms
Enter
Sleep 6s
