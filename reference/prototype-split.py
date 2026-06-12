# Prototyp: Mensch-aktiv vs. AI-solo Split aus Claude-Code-JSONLs.
# Entstanden 2026-06-12 an echten Projektdaten verifiziert
# (37,3h gesamt → 21,6h Mensch-aktiv / 15,8h AI-solo bei Cap 10).
# Referenz-Kernalgorithmus (Merge, Caps, by-session): ~/.claude/skills/claude-hours/claude_hours.py
import json, glob, os, sys
from datetime import datetime, timedelta
from collections import defaultdict

LOGDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    '~/.claude/projects/' + os.getcwd().replace('/', '-'))

all_events = []  # (ts, kind)  kind: 'prompt' = echter User-Input | 'work' = Assistant/Tools
for f in glob.glob(LOGDIR + '/*.jsonl'):
    for line in open(f, errors='ignore'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        ts = o.get('timestamp')
        if not ts:
            continue
        t = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        kind = 'work'
        # Echter Prompt: type=user, kein tool_result-Inhalt, kein isMeta
        if o.get('type') == 'user' and not o.get('isMeta'):
            c = (o.get('message') or {}).get('content')
            is_prompt = isinstance(c, str) or (
                isinstance(c, list)
                and any(i.get('type') == 'text' for i in c if isinstance(i, dict))
                and not any(i.get('type') == 'tool_result' for i in c if isinstance(i, dict)))
            if is_prompt:
                kind = 'prompt'
        all_events.append((t, kind))

all_events.sort()

def active_hours(times, cap_min):
    cap = timedelta(minutes=cap_min)
    tot = timedelta()
    for a, b in zip(times, times[1:]):
        d = b - a
        tot += d if d <= cap else cap
    return tot.total_seconds() / 3600

times_all = [t for t, k in all_events]
times_prompts = [t for t, k in all_events if k == 'prompt']
ges, phil = active_hours(times_all, 10), active_hours(times_prompts, 10)
print(f'Events: {len(times_all)} | Prompts: {len(times_prompts)}')
print(f'Gesamt (Cap 10):        {ges:.1f} h')
print(f'Mensch-aktiv (Cap 10):  {phil:.1f} h')
print(f'AI-solo:                {ges - phil:.1f} h\n')

days = defaultdict(lambda: {'all': [], 'p': []})
for t, k in all_events:
    d = (t + timedelta(hours=2)).date().isoformat()  # TODO: --tz-offset
    days[d]['all'].append(t)
    if k == 'prompt':
        days[d]['p'].append(t)
print('Tag         | Gesamt | Mensch | AI-solo | Prompts')
for d in sorted(days):
    g, p = active_hours(days[d]['all'], 10), active_hours(days[d]['p'], 10)
    print(f'{d}  | {g:5.1f}h | {p:5.1f}h | {g - p:6.1f}h | {len(days[d]["p"]):4d}')
