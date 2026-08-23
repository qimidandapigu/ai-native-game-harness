from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .config import Settings


MOD_NAME = "dont-starve-ai-mod"
FORCE_ENABLE_LINE = f'ForceEnableMod("{MOD_NAME}")'
LAUNCHER_NAME = "ChesterAI.exe"
LAUNCH_OPTION_FILENAME = "Steam启动项.txt"


def bundled_game_mod_dir() -> Path:
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS"))
        return bundle_root / "game-mod"
    return Path(__file__).resolve().parents[2] / "game-mod"


def _write_if_changed(path: Path, content: str) -> bool:
    current = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    if current == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".chester-ai.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
    return True


def enable_modsettings(content: str) -> str:
    if FORCE_ENABLE_LINE in content:
        return content
    separator = "" if not content or content.endswith("\n") else "\n"
    return f"{content}{separator}\n{FORCE_ENABLE_LINE}\nDisableLocalModWarning()\n"


def enable_modoverride(content: str) -> str:
    if f'["{MOD_NAME}"]' in content:
        return content
    marker = "return {"
    if marker not in content:
        return content
    entry = (
        f'{marker}\n  ["{MOD_NAME}"]={{\n'
        '    ["configuration_options"]={},\n'
        '    ["enabled"]=true\n'
        "  },"
    )
    return content.replace(marker, entry, 1)


def discover_modoverrides() -> list[Path]:
    home = Path.home()
    roots = [
        home / "Documents" / "Klei" / "DoNotStarveTogether",
        home / "OneDrive" / "Documents" / "Klei" / "DoNotStarveTogether",
    ]
    found: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob("modoverrides.lua"):
            if path not in found:
                found.append(path)
    return found


def ensure_game_mod(settings: Settings) -> list[str]:
    if settings.game_dir is None:
        raise RuntimeError("没有找到《饥荒联机版》的安装目录")

    source = bundled_game_mod_dir()
    if not (source / "modmain.lua").is_file() or not (source / "modinfo.lua").is_file():
        raise RuntimeError(f"安装包中缺少 Lua Mod 文件：{source}")

    actions: list[str] = []
    destination = settings.game_dir / "mods" / MOD_NAME
    destination.mkdir(parents=True, exist_ok=True)
    for filename in ("modmain.lua", "modinfo.lua"):
        source_file = source / filename
        destination_file = destination / filename
        if not destination_file.exists() or source_file.read_bytes() != destination_file.read_bytes():
            shutil.copy2(source_file, destination_file)
            actions.append(f"已安装 {filename}")

    source_anim = source / "anim"
    if source_anim.is_dir():
        destination_anim = destination / "anim"
        shutil.copytree(source_anim, destination_anim, dirs_exist_ok=True)
        actions.append("已安装 anim")

    modsettings = settings.game_dir / "mods" / "modsettings.lua"
    original = modsettings.read_text(encoding="utf-8", errors="replace") if modsettings.exists() else ""
    if _write_if_changed(modsettings, enable_modsettings(original)):
        actions.append("已启用本地 Mod")

    for override in discover_modoverrides():
        original = override.read_text(encoding="utf-8", errors="replace")
        updated = enable_modoverride(original)
        if updated != original and _write_if_changed(override, updated):
            actions.append(f"已为世界启用 Mod：{override.parent.parent.name}/{override.parent.name}")
    return actions


def install_player_launcher(settings: Settings) -> tuple[Path, str, list[str]]:
    """Install the packaged launcher beside the Lua mod for this DST installation."""
    if settings.game_dir is None:
        raise RuntimeError("没有找到《饥荒联机版》的安装目录")
    if not getattr(sys, "frozen", False):
        raise RuntimeError("请先生成 ChesterAI.exe，再安装玩家启动器")

    actions = ensure_game_mod(settings)
    source_dir = Path(sys.executable).resolve().parent
    destination = settings.game_dir / "mods" / MOD_NAME
    destination.mkdir(parents=True, exist_ok=True)

    source_exe = Path(sys.executable).resolve()
    destination_exe = destination / LAUNCHER_NAME
    if source_exe != destination_exe.resolve():
        shutil.copy2(source_exe, destination_exe)
        actions.append(f"已安装 {LAUNCHER_NAME}")

    for filename in (".env.example",):
        source_file = source_dir / filename
        destination_file = destination / filename
        if source_file.is_file():
            if not destination_file.exists() or source_file.read_bytes() != destination_file.read_bytes():
                shutil.copy2(source_file, destination_file)
                actions.append(f"已安装 {filename}")

    launch_option = f'"{destination_exe}" %command%'
    option_file = destination / LAUNCH_OPTION_FILENAME
    if _write_if_changed(option_file, f"{launch_option}\n"):
        actions.append(f"已生成 {LAUNCH_OPTION_FILENAME}")
    legacy_option_file = destination / "Steam-Launch-Option.txt"
    if legacy_option_file.is_file():
        legacy_option_file.unlink()
    return destination, launch_option, actions
