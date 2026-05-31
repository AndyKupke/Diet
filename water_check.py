"""
Sterling Concorde — Hourly health check agent.
Fetches Oura ring data (today + 14-day history), writes oura_data.json
to the repo, and sends Pushover notifications when thresholds are missed.
"""

import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

import requests

# ── Config ────────────────────────────────────────────────────────────────
OURA_TOKEN     = os.environ["OURA_TOKEN"]
PUSHOVER_TOKEN = os.environ.get("PUSHOVER_TOKEN", "")
PUSHOVER_USER  = os.environ.get("PUSHOVER_USER", "")

TARGETS = {
    "water_ml":  2500,
    "calories":  1750,
    "protein_g": 140,
}

TODAY = date.today().isoformat()


# ── Data loading ──────────────────────────────────────────────────────────
def load_tracker_data() -> dict:
    path = os.path.join(os.path.dirname(__file__), "data.json")
    try:
        with open(path) as f:
            data = json.load(f)
        today_state = data.get("today", data)  # support both old and new format
        if today_state.get("date") != TODAY:
            return {"date": TODAY, "water_ml": 0, "calories": 0, "protein_g": 0,
                    "meals": [], "exercise": [], "weight_kg": None}
        return today_state
    except (FileNotFoundError, json.JSONDecodeError):
        return {"date": TODAY, "water_ml": 0, "calories": 0, "protein_g": 0,
                "meals": [], "exercise": [], "weight_kg": None}


# ── Oura API ──────────────────────────────────────────────────────────────
def safe_get(base: str, endpoint: str, params: dict, headers: dict) -> list:
    try:
        r = requests.get(f"{base}/{endpoint}", headers=headers, params=params, timeout=15)
        if r.ok:
            return r.json().get("data", [])
    except Exception as e:
        print(f"[oura] {endpoint} fetch error: {e}", file=sys.stderr)
    return []


def fetch_oura_full(days: int = 14) -> tuple[dict, list]:
    """Fetch today + last `days` days of Oura data. Returns (today_dict, history_list)."""
    headers = {"Authorization": f"Bearer {OURA_TOKEN}"}
    base    = "https://api.ouraring.com/v2/usercollection"

    end_date   = date.today()
    start_date = end_date - timedelta(days=days - 1)
    start_str  = start_date.isoformat()
    end_str    = end_date.isoformat()

    readiness_data = safe_get(base, "daily_readiness", {"start_date": start_str, "end_date": end_str}, headers)
    sleep_data     = safe_get(base, "daily_sleep",     {"start_date": start_str, "end_date": end_str}, headers)
    activity_data  = safe_get(base, "daily_activity",  {"start_date": start_str, "end_date": end_str}, headers)
    workout_data   = safe_get(base, "workout",         {"start_date": TODAY,     "end_date": end_str}, headers)

    by_date: dict[str, dict] = {}

    for d in readiness_data:
        day = d.get("day") or (d.get("timestamp") or "")[:10]
        if not day:
            continue
        by_date.setdefault(day, {"date": day})
        c = d.get("contributors", {})
        by_date[day]["readiness"] = {
            "score":       d.get("score"),
            "resting_hr":  c.get("resting_heart_rate"),
            "hrv":         c.get("hrv_balance"),
            "recovery":    c.get("recovery_index"),
            "temperature": c.get("body_temperature"),
        }

    for d in sleep_data:
        day = d.get("day") or (d.get("timestamp") or "")[:10]
        if not day:
            continue
        by_date.setdefault(day, {"date": day})
        c = d.get("contributors", {})
        by_date[day]["sleep"] = {
            "score":         d.get("score"),
            "total_sleep_s": c.get("total_sleep"),
            "deep_sleep_s":  c.get("deep_sleep"),
            "rem_sleep_s":   c.get("rem_sleep"),
            "efficiency":    c.get("sleep_efficiency"),
            "latency":       c.get("sleep_latency"),
            "timing":        c.get("sleep_timing"),
        }

    for d in activity_data:
        day = d.get("day") or (d.get("timestamp") or "")[:10]
        if not day:
            continue
        by_date.setdefault(day, {"date": day})
        by_date[day]["activity"] = {
            "score":            d.get("score"),
            "active_calories":  d.get("active_calories"),
            "total_calories":   d.get("total_calories"),
            "steps":            d.get("steps"),
            "equivalent_walking_distance": d.get("equivalent_walking_distance"),
            "meters_to_target": d.get("meters_to_target"),
            "high_activity":    d.get("high_activity_time"),
            "medium_activity":  d.get("medium_activity_time"),
            "low_activity":     d.get("low_activity_time"),
            "sedentary":        d.get("sedentary_time"),
        }

    workouts = []
    for w in workout_data:
        workouts.append({
            "activity":   w.get("activity"),
            "calories":   w.get("calories"),
            "duration_s": w.get("duration"),
            "start":      w.get("start_datetime"),
            "distance_m": w.get("distance"),
            "avg_hr":     w.get("average_heart_rate"),
            "max_hr":     w.get("max_heart_rate"),
        })

    today_entry = by_date.get(TODAY, {"date": TODAY})
    today_entry["workouts"] = workouts

    history = [v for k, v in sorted(by_date.items()) if k != TODAY]

    print(f"[oura] today: readiness={today_entry.get('readiness', {}).get('score')}  "
          f"sleep={today_entry.get('sleep', {}).get('score')}  "
          f"steps={today_entry.get('activity', {}).get('steps')}")
    print(f"[oura] history: {len(history)} days fetched")
    return today_entry, history


def write_oura_data(today_data: dict, history: list) -> None:
    """Write oura_data.json and commit/push to repo."""
    output = {
        "updated":  datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "today":    today_data,
        "history":  history,
    }
    path = os.path.join(os.path.dirname(__file__), "oura_data.json")
    with open(path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"[oura] wrote {path}")

    try:
        subprocess.run(["git", "config", "user.email", "agent@diet-tracker"], check=True)
        subprocess.run(["git", "config", "user.name",  "Diet Agent"],         check=True)
        subprocess.run(["git", "add", "oura_data.json"],                      check=True)
        diff = subprocess.run(["git", "diff", "--staged", "--quiet"])
        if diff.returncode != 0:
            subprocess.run(["git", "commit", "-m", f"oura: update data {TODAY}"], check=True)
            subprocess.run(["git", "push"], check=True)
            print("[oura] oura_data.json committed and pushed")
        else:
            print("[oura] oura_data.json unchanged — no commit needed")
    except subprocess.CalledProcessError as e:
        print(f"[oura] git push failed: {e}", file=sys.stderr)


# ── Notification ──────────────────────────────────────────────────────────
def push(title: str, message: str, priority: int = 0) -> None:
    if not PUSHOVER_TOKEN or not PUSHOVER_USER:
        print(f"[push] (no Pushover configured) {title}: {message}")
        return
    resp = requests.post("https://api.pushover.net/1/messages.json", data={
        "token":    PUSHOVER_TOKEN,
        "user":     PUSHOVER_USER,
        "title":    title,
        "message":  message,
        "priority": priority,
        "sound":    "none",
    }, timeout=10)
    resp.raise_for_status()
    print(f"[push] {title}: {message}")


# ── Check logic ───────────────────────────────────────────────────────────
def current_hour() -> int:
    return datetime.now(timezone.utc).hour


def should_remind_water(water_ml: int, hour: int) -> tuple[bool, str]:
    expected = int((hour / 24) * TARGETS["water_ml"])
    if water_ml < expected * 0.7:
        behind = expected - water_ml
        return True, f"You're {behind} ml behind pace ({water_ml}/{TARGETS['water_ml']} ml logged)."
    return False, ""


def build_status_message(tracker: dict, oura: dict, hour: int) -> str | None:
    lines = []
    behind, msg = should_remind_water(tracker["water_ml"], hour)
    if behind:
        lines.append(f"💧 {msg}")
    if hour >= 18 and tracker["calories"] < 1200:
        lines.append(f"🍽 Only {tracker['calories']} kcal logged today — target is {TARGETS['calories']}.")
    if hour >= 20 and tracker["protein_g"] < TARGETS["protein_g"] * 0.8:
        lines.append(f"🥩 Protein at {tracker['protein_g']}g — target ≥{TARGETS['protein_g']}g.")
    r = oura.get("readiness", {})
    s = oura.get("sleep", {})
    if r.get("score") and r["score"] < 60:
        lines.append(f"⚠️ Readiness score low: {r['score']}/100 — consider a lighter session.")
    total_s = s.get("total_sleep_s") or 0
    sleep_h = round(total_s / 3600, 1) if total_s else None
    if sleep_h and sleep_h < 6.5:
        lines.append(f"😴 Sleep was short: {sleep_h}h. Prioritise recovery today.")
    return "\n".join(lines) if lines else None


def build_summary_message(tracker: dict, oura: dict) -> str:
    w_pct    = int(tracker["water_ml"] / TARGETS["water_ml"] * 100)
    kcal_diff = tracker["calories"] - TARGETS["calories"]
    kcal_str  = f"+{kcal_diff}" if kcal_diff > 0 else str(kcal_diff)
    lines = [
        f"📊 Diet Tracker — Daily summary {TODAY}", "",
        f"Calories:  {tracker['calories']} kcal ({kcal_str})",
        f"Protein:   {tracker['protein_g']}g / {TARGETS['protein_g']}g",
        f"Water:     {tracker['water_ml']} ml ({w_pct}%)",
    ]
    if tracker.get("weight_kg"):
        diff = round(tracker["weight_kg"] - 72, 1)
        lines.append(f"Weight:    {tracker['weight_kg']} kg ({'+' if diff > 0 else ''}{diff} from goal)")
    r = oura.get("readiness", {})
    s = oura.get("sleep", {})
    a = oura.get("activity", {})
    if r or s or a:
        lines.append("")
        if r.get("score"): lines.append(f"Readiness: {r['score']}/100")
        total_s = s.get("total_sleep_s") or 0
        sleep_h = round(total_s / 3600, 1) if total_s else None
        if s.get("score"):
            lines.append(f"Sleep:     {s['score']}/100" + (f" ({sleep_h}h)" if sleep_h else ""))
        if a.get("score"):
            lines.append(f"Activity:  {a['score']}/100 | {a.get('steps', 0):,} steps")
    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────
def main():
    hour = current_hour()
    print(f"[agent] Running at UTC hour {hour} for {TODAY}")

    tracker = load_tracker_data()
    print(f"[tracker] water={tracker['water_ml']}ml  kcal={tracker['calories']}  protein={tracker['protein_g']}g")

    today_oura: dict = {}
    try:
        today_oura, history = fetch_oura_full(days=14)
        write_oura_data(today_oura, history)
    except Exception as e:
        print(f"[oura] fetch/write failed: {e}", file=sys.stderr)

    # End-of-day summary at 21:00 UTC
    if hour == 21:
        msg = build_summary_message(tracker, today_oura)
        push("Diet Tracker — Daily Summary", msg)
        return

    # Intra-day reminders
    alert = build_status_message(tracker, today_oura, hour)
    if alert:
        push("Diet Tracker", alert)
    else:
        print("[agent] All checks passed — no notification sent.")


if __name__ == "__main__":
    main()
