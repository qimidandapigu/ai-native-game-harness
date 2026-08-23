from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


GAME_FOLDER = "Don't Starve Together"
STATE_FILENAME = "dont_starve_ai_mod_state.json"
REPLY_FILENAME = "dont_starve_ai_mod_reply.json"
REQUEST_FILENAME = "dont_starve_ai_mod_requests.json"
BRIDGE_STATUS_FILENAME = "dont_starve_ai_mod_bridge_status.json"
SKILL_COMMAND_FILENAME = "dont_starve_ai_mod_skill_command.json"
SKILL_RESULT_FILENAME = "dont_starve_ai_mod_skill_result.json"


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return value.strip()


def _load_env_file(path: Path) -> None:
    """Load the small, secret-free Adapter config without an extra dependency."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


def parse_steam_library_paths(text: str) -> list[Path]:
    """Extract Steam library paths from libraryfolders.vdf without a VDF dependency."""
    paths: list[Path] = []
    for raw in re.findall(r'"path"\s+"([^"]+)"', text, flags=re.IGNORECASE):
        path = Path(raw.replace("\\\\", "\\"))
        if path not in paths:
            paths.append(path)
    return paths


def _steam_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _ = winreg.QueryValueEx(key, "SteamPath")
            roots.append(Path(value))
    except (ImportError, OSError):
        pass
    roots.extend(
        Path(value)
        for value in (
            r"C:\Program Files (x86)\Steam",
            r"C:\Program Files\Steam",
            r"D:\SteamLibrary",
            r"E:\Steam",
            r"F:\SteamLibrary",
        )
    )
    return list(dict.fromkeys(roots))


def discover_dst_game_dir() -> Path | None:
    candidates: list[Path] = []
    for steam_root in _steam_roots():
        candidates.append(steam_root / "steamapps" / "common" / GAME_FOLDER)
        vdf = steam_root / "steamapps" / "libraryfolders.vdf"
        try:
            library_text = vdf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for library in parse_steam_library_paths(library_text):
            candidates.append(library / "steamapps" / "common" / GAME_FOLDER)
    for candidate in candidates:
        if (candidate / "data" / "databundles" / "scripts.zip").is_file():
            return candidate.resolve()
    return None


@dataclass(frozen=True)
class Settings:
    gateway_url: str
    connection_timeout_seconds: float
    request_timeout_seconds: float
    game_dir: Path | None
    state_file: Path | None
    reply_file: Path | None
    request_file: Path | None
    bridge_status_file: Path | None
    skill_command_file: Path | None
    skill_result_file: Path | None
    runtime_dir: Path

    @property
    def log_file(self) -> Path:
        return self.runtime_dir / "chester-adapter.log"

    def configuration_errors(self) -> list[str]:
        parsed = urlparse(self.gateway_url)
        if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return ["HARNESS_GATEWAY_URL 必须是本机 ws:// 地址"]
        if (
            self.request_file is None
            or self.reply_file is None
            or self.skill_command_file is None
            or self.skill_result_file is None
        ):
            return ["没有找到《饥荒联机版》目录，无法定位 Lua Bridge 文件"]
        return []


def load_settings(project_root: Path | None = None) -> Settings:
    if project_root is not None:
        root = project_root.resolve()
    elif getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent
    else:
        root = Path(__file__).resolve().parents[2]
    _load_env_file(root / ".env")

    configured_game_dir = _env("DST_GAME_DIR")
    game_dir = (
        Path(configured_game_dir).expanduser().resolve()
        if configured_game_dir
        else discover_dst_game_dir()
    )
    default_unsafedata = game_dir / "data" / "unsafedata" if game_dir else None

    def bridge_path(variable: str, filename: str) -> Path | None:
        configured = _env(variable)
        if configured:
            return Path(configured).expanduser().resolve()
        return default_unsafedata / filename if default_unsafedata else None

    runtime_dir = root / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        gateway_url=_env("HARNESS_GATEWAY_URL", "ws://127.0.0.1:32145"),
        connection_timeout_seconds=max(1.0, float(_env("HARNESS_CONNECTION_TIMEOUT_SECONDS", "3"))),
        request_timeout_seconds=max(5.0, float(_env("HARNESS_REQUEST_TIMEOUT_SECONDS", "120"))),
        game_dir=game_dir,
        state_file=bridge_path("DST_STATE_FILE", STATE_FILENAME),
        reply_file=bridge_path("DST_REPLY_FILE", REPLY_FILENAME),
        request_file=bridge_path("DST_REQUEST_FILE", REQUEST_FILENAME),
        bridge_status_file=bridge_path("DST_BRIDGE_STATUS_FILE", BRIDGE_STATUS_FILENAME),
        skill_command_file=bridge_path("DST_SKILL_COMMAND_FILE", SKILL_COMMAND_FILENAME),
        skill_result_file=bridge_path("DST_SKILL_RESULT_FILE", SKILL_RESULT_FILENAME),
        runtime_dir=runtime_dir,
    )
