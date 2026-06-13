#!/usr/bin/env python3
"""Claude Hours — Zeiterfassung aus Claude-Code Session-Logs.

Liest die JSONL-Logs aus ~/.claude/projects/<projekt-hash>/ und berechnet
gearbeitete Stunden via Inter-Message-Time mit Idle-Cap (Branchen-Standard).

Auto-detect: konvertiert das aktuelle Working-Directory in den Hash-Pfad
(/Users/x/code/foo -> -Users-x-code-foo).
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone, timedelta


def project_to_hash(path: str) -> str:
    """Wandelt einen Pfad in das von Claude Code verwendete Hash-Format um.

    Zwei nicht-offensichtliche Regeln (an echten Ordnern verifiziert):
    1. Claude Code ersetzt JEDES Nicht-Alphanumerische Zeichen durch "-" (nicht
       nur den Pfadtrenner): "manuel-mühlhoffs-bot" -> "manuel-m-hlhoffs-bot".
    2. macOS liefert Pfade in NFD-Form (das "ü" kommt zerlegt als "u" +
       kombinierender Akzent), Claude Code legt den Ordner aber in NFC an. Ohne
       vorheriges NFC-Normalisieren bleibt das "u" als "mu-" stehen und der
       Ordner wird verfehlt.
    """
    abs_path = unicodedata.normalize("NFC", os.path.abspath(path))
    return re.sub(r"[^a-zA-Z0-9]", "-", abs_path)


def parse_date(s: str) -> datetime:
    """Parst YYYY-MM-DD, YYYY-MM-DD HH:MM, oder ISO-Timestamp.

    Bei `YYYY-MM-DD HH:MM` wird die lokale tz_offset NICHT angewandt — der Caller
    übergibt explizit UTC-Zeitpunkte. Für lokale-Stunden-Filter: `--tz-offset` setzen
    und Stunden in lokaler Zeit angeben, dann konvertiert die UI vorher.
    """
    if "T" in s:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    if " " in s:
        # YYYY-MM-DD HH:MM oder YYYY-MM-DD HH:MM:SS
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        raise ValueError(f"Datum '{s}' nicht parsebar (erwartet: YYYY-MM-DD oder YYYY-MM-DD HH:MM)")
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def load_session_timestamps(jsonl_path: str, start: datetime, end: datetime) -> list[datetime]:
    """Liest alle Timestamps aus einer Session-JSONL, gefiltert auf [start, end]."""
    timestamps: list[datetime] = []
    try:
        with open(jsonl_path) as f:
            for line in f:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts_str = record.get("timestamp")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if start <= ts <= end:
                    timestamps.append(ts)
    except OSError:
        return []
    timestamps.sort()
    return timestamps


def active_minutes(timestamps: list[datetime], cap_minutes: float) -> float:
    """Summe der Inter-Message-Zeit, gecapped pro Lücke auf cap_minutes.

    Branchen-Standard (WakaTime, RescueTime): Pausen > Cap zählen mit cap_minutes
    Bonus. Damit wird kurze Denkpause als Arbeit gezählt, aber 50min Mittagspause
    bekommt nur 10min Cap-Anteil.
    """
    if len(timestamps) < 2:
        return 0.0
    total = 0.0
    for prev, curr in zip(timestamps, timestamps[1:]):
        gap = (curr - prev).total_seconds() / 60.0
        total += min(gap, cap_minutes)
    return total


def active_minutes_strict(timestamps: list[datetime], cap_minutes: float) -> float:
    """Reine AI-Aktivzeit: Pausen > Cap zählen 0, KEIN Cap-Bonus.

    Strenger als `active_minutes`. Wenn der User isst und du auf Subagents
    wartest (Pause > 10min), wird das vollständig als Idle gewertet. Nur Gaps
    INNERHALB des Cap zählen voll.

    Anwendung: ehrliche Untergrenze für Papierkram bei AI-Orchestrator-Sessions
    mit langen Background-Wartephasen. Verhindert "10min-Bonus pro Mittagspause".
    """
    if len(timestamps) < 2:
        return 0.0
    total = 0.0
    for prev, curr in zip(timestamps, timestamps[1:]):
        gap = (curr - prev).total_seconds() / 60.0
        if gap <= cap_minutes:
            total += gap
        # else: Pause > Cap → 0 (nicht cap_minutes)
    return total


def find_pauses(timestamps: list[datetime], min_minutes: float) -> list[tuple[datetime, datetime, float]]:
    """Findet alle Gaps >= min_minutes (sortiert absteigend nach Dauer)."""
    if len(timestamps) < 2:
        return []
    pauses: list[tuple[datetime, datetime, float]] = []
    for prev, curr in zip(timestamps, timestamps[1:]):
        gap = (curr - prev).total_seconds() / 60.0
        if gap >= min_minutes:
            pauses.append((prev, curr, gap))
    pauses.sort(key=lambda p: -p[2])
    return pauses


def merge_timestamps(sessions: list[list[datetime]]) -> list[datetime]:
    """Merged alle Session-Timestamps in EINE sortierte Timeline.

    Kritisch bei parallel laufenden Sessions: Pro-Session-Summen würden
    überlappende Arbeitszeit DOPPELT zählen (zwei Sessions, die im selben
    Zeitfenster laufen, ergäben in Summe mehr Stunden als die Uhr hergibt).
    Über die gemergte Timeline wird jede reale Minute nur einmal gezählt.
    """
    merged: list[datetime] = []
    for s in sessions:
        merged.extend(s)
    merged.sort()
    return merged


def detect_overlaps(named_sessions: list[tuple[str, list[datetime]]]) -> bool:
    """True, wenn sich die Zeitfenster von mindestens zwei Sessions überlappen."""
    ranges = sorted((s[0], s[-1]) for _, s in named_sessions if len(s) >= 2)
    for i in range(1, len(ranges)):
        if ranges[i][0] < ranges[i - 1][1]:
            return True
    return False


def find_project_dir(project_arg: str | None) -> str:
    """Liefert das Projekt-Verzeichnis in ~/.claude/projects/ zurück."""
    base = os.path.expanduser("~/.claude/projects")
    if project_arg:
        # Wenn Pfad: wandle um. Wenn Hash: direkt.
        if os.sep in project_arg or project_arg.startswith("/"):
            hash_name = project_to_hash(project_arg)
        else:
            hash_name = project_arg
    else:
        hash_name = project_to_hash(os.getcwd())
    project_dir = os.path.join(base, hash_name)
    if not os.path.isdir(project_dir):
        sys.exit(
            f"FEHLER: Projekt-Verzeichnis nicht gefunden: {project_dir}\n"
            f"Tipp: --project <pfad> angeben oder aus dem Projekt-Root aufrufen."
        )
    return project_dir


def main() -> None:
    p = argparse.ArgumentParser(
        description="Claude Hours — gearbeitete Stunden aus Claude-Code-Logs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Beispiele:\n"
            "  claude-hours                          # aktuelles Projekt, alle Zeiten\n"
            "  claude-hours --since 2026-04-08       # ab Datum\n"
            "  claude-hours --since 2026-04-08 --until 2026-05-08 --by-day\n"
            "  claude-hours --csv > zeiten.csv       # Papierkram-Export\n"
            "  claude-hours --project /pfad/zu/repo  # anderes Projekt\n"
        ),
    )
    p.add_argument("--project", help="Pfad zum Projekt (oder Hash). Default: cwd")
    p.add_argument("--since", help="Start-Datum (YYYY-MM-DD), inklusive")
    p.add_argument("--until", help="End-Datum (YYYY-MM-DD), inklusive")
    p.add_argument("--cap", type=float, default=10.0, help="Idle-Cap in Minuten (Default: 10)")
    p.add_argument("--by-day", action="store_true", help="Pro-Tag-Breakdown ausgeben")
    p.add_argument("--by-session", action="store_true", help="Pro-Session-Breakdown (Datei, Zeitfenster, Aktivzeit) — wichtig bei parallelen Sessions")
    p.add_argument("--csv", action="store_true", help="CSV-Format (für Papierkram-Import)")
    p.add_argument("--tz-offset", type=int, default=2, help="UTC-Offset in Stunden für Tages-Bucketing (Default: 2 = MESZ)")
    p.add_argument("--pauses", action="store_true", help="Top-N längste Pausen anzeigen (Idle > Cap). Default an wenn echte Pausen erkannt.")
    p.add_argument("--top-pauses", type=int, default=10, help="Wie viele Pausen zeigen (Default: 10)")

    args = p.parse_args()

    start = parse_date(args.since) if args.since else datetime(1970, 1, 1, tzinfo=timezone.utc)
    # Bei reinem Datum (YYYY-MM-DD ohne Uhrzeit) → End-of-Day. Bei HH:MM → exakt.
    if args.until:
        if " " in args.until or "T" in args.until:
            end = parse_date(args.until)
        else:
            end = parse_date(args.until + "T23:59:59Z")
    else:
        end = datetime(2100, 1, 1, tzinfo=timezone.utc)

    project_dir = find_project_dir(args.project)
    jsonl_files = sorted(glob.glob(os.path.join(project_dir, "*.jsonl")))

    named_sessions: list[tuple[str, list[datetime]]] = []
    for fp in jsonl_files:
        ts = load_session_timestamps(fp, start, end)
        if ts:
            named_sessions.append((os.path.basename(fp), ts))

    if not named_sessions:
        print("Keine Sessions im Zeitraum gefunden.", file=sys.stderr)
        sys.exit(1)

    sessions = [ts for _, ts in named_sessions]
    merged = merge_timestamps(sessions)            # EINE Timeline, keine Doppelzählung
    overlapping = detect_overlaps(named_sessions)
    total_msgs = len(merged)

    # CSV-Output: ein Tag pro Zeile, Papierkram-kompatibel.
    # Auf der gemergten Timeline gerechnet — parallele Sessions zählen nicht doppelt.
    if args.csv:
        local_tz = timezone(timedelta(hours=args.tz_offset))
        day_minutes: dict[str, float] = {}
        for prev, curr in zip(merged, merged[1:]):
            gap = (curr - prev).total_seconds() / 60.0
            gap_capped = min(gap, args.cap)
            day = prev.astimezone(local_tz).date().isoformat()
            day_minutes[day] = day_minutes.get(day, 0) + gap_capped
        writer = csv.writer(sys.stdout, delimiter=";")
        writer.writerow(["Datum", "Dauer (h)", "Dauer (Stunden:Minuten)"])
        for day in sorted(day_minutes):
            mins = day_minutes[day]
            h, m = divmod(int(mins), 60)
            writer.writerow([day, f"{mins/60:.2f}", f"{h}:{m:02d}"])
        return

    # Standard-Ausgabe (menschenlesbar)
    print(f"Projekt-Logs: {project_dir}")
    print(f"Zeitraum: {args.since or 'Anfang'} – {args.until or 'jetzt'}")
    print(f"Sessions im Zeitraum: {len(named_sessions)}")
    print(f"Total Messages: {total_msgs:,}".replace(",", "."))
    print()
    print("Claude-Code-Aktivität (verschiedene Idle-Caps):")
    print(f"  {'Cap':<8} {'mit Cap-Bonus':<16} {'rein (Pause>Cap=0)':<22}")
    for cap in [1, 2, 3, 5, 10, 15]:
        h = active_minutes(merged, cap) / 60
        h_strict = active_minutes_strict(merged, cap) / 60
        marker = "  ← Standard" if cap == int(args.cap) else ""
        if cap == 2:
            marker += "  ← reine Arbeitszeit"
        print(f"  {cap:>2}min    {h:>5.2f}h           {h_strict:>5.2f}h{marker}")
    print()
    print("  mit Cap-Bonus: Branchen-Standard (Pause > Cap zählt Cap-Min als Arbeit).")
    print("  rein         : strikt — Pause > Cap zählt 0. Für ehrliche Untergrenze bei")
    print("                 Background-Heavy-Sessions (Orchestrator-Wartezeiten).")
    print()

    # Pausen-Section: zeige Top-N längste Gaps wenn welche > Cap existieren
    real_pauses = find_pauses(merged, args.cap)
    if real_pauses:
        local_tz = timezone(timedelta(hours=args.tz_offset))
        n = min(args.top_pauses, len(real_pauses))
        idle_total = sum(p[2] for p in real_pauses)
        cap_bonus = len(real_pauses) * args.cap
        print(f"Pausen > {args.cap:.0f}min Cap ({len(real_pauses)} Stück, gesamt {idle_total/60:.2f}h Idle):")
        print(f"  Cap-Bonus-Effekt: {cap_bonus:.0f}min ({cap_bonus/60:.2f}h) werden bei Standard-Methode noch als Arbeit gezählt.")
        print()
        print(f"  Top-{n} längste Pausen (Anzeige in tz_offset={args.tz_offset:+d}h):")
        for i, (s, e, mins) in enumerate(real_pauses[:n], 1):
            s_loc = s.astimezone(local_tz).strftime("%H:%M:%S")
            e_loc = e.astimezone(local_tz).strftime("%H:%M:%S")
            if mins >= 60:
                gap_str = f"{int(mins//60)}h{int(mins%60):02d}m"
            else:
                gap_str = f"{mins:.1f} min"
            print(f"    {i:>2}. {s_loc} – {e_loc}  →  {gap_str}")
        print()

    if overlapping:
        print("⚠  ACHTUNG: Mehrere Sessions liefen ZEITLICH PARALLEL.")
        print("   Die Stunden oben sind über die gemergte Timeline berechnet")
        print("   (jede reale Minute nur einmal — keine Doppelzählung).")
        print("   Aufschlüsselung welche Session welche ist: --by-session")
        print()

    if args.by_session:
        local_tz = timezone(timedelta(hours=args.tz_offset))
        print(f"Pro Session (Cap {args.cap:.0f}min):")
        for name, sess in named_sessions:
            a = active_minutes(sess, args.cap) / 60
            f0 = sess[0].astimezone(local_tz)
            l0 = sess[-1].astimezone(local_tz)
            print(f"  {name}")
            print(f"    {f0:%Y-%m-%d %H:%M} – {l0:%Y-%m-%d %H:%M} | {len(sess):>4} msgs | {a:>5.2f}h aktiv")
        print()
        sum_h = sum(active_minutes(s, args.cap) for s in sessions) / 60
        merged_h = active_minutes(merged, args.cap) / 60
        print(f"  Summe Einzel-Sessions (mit Doppelzählung): {sum_h:.2f}h")
        print(f"  Gemergte Timeline (echte Aktivzeit):       {merged_h:.2f}h")
        print()

    if args.by_day:
        local_tz = timezone(timedelta(hours=args.tz_offset))
        day_minutes: dict[str, float] = {}
        day_msgs: dict[str, int] = {}
        for t in merged:
            day = t.astimezone(local_tz).date().isoformat()
            day_msgs[day] = day_msgs.get(day, 0) + 1
        for prev, curr in zip(merged, merged[1:]):
            gap = (curr - prev).total_seconds() / 60.0
            gap_capped = min(gap, args.cap)
            day = prev.astimezone(local_tz).date().isoformat()
            day_minutes[day] = day_minutes.get(day, 0) + gap_capped
        print(f"Pro Tag (Cap {args.cap:.0f}min):")
        for day in sorted(day_minutes):
            print(f"  {day} | {day_minutes[day]/60:>5.2f}h | {day_msgs.get(day, 0):>4} Messages")
        print()
        total = sum(day_minutes.values()) / 60
        print(f"Summe: {total:.1f} h ({len(day_minutes)} aktive Tage)")


if __name__ == "__main__":
    main()
