from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def read_game_state(path: Path | None, attempts: int = 3) -> dict[str, Any]:
    if path is None:
        return {"available": False, "reason": "DST state path could not be discovered"}

    last_error = "state file has not been written yet"
    for attempt in range(attempts):
        try:
            raw = path.read_text(encoding="utf-8")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("state root is not an object")
            age_seconds = max(0.0, time.time() - path.stat().st_mtime)
            return {
                "available": True,
                "age_seconds": round(age_seconds, 2),
                "stale": age_seconds > 5,
                "data": value,
            }
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            last_error = str(exc)
            if attempt + 1 < attempts:
                time.sleep(0.05)
    return {"available": False, "path": str(path), "reason": last_error}


def build_context(game_state: dict[str, Any], window: dict[str, Any]) -> dict[str, Any]:
    return {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "game": "Don't Starve Together",
        "window": window,
        "mod_state": game_state,
    }


def save_context(path: Path, context: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")
