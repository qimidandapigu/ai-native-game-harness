import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dont_starve_ai_mod.mod_installer import (
    enable_modoverride,
    enable_modsettings,
    ensure_game_mod,
    install_player_launcher,
)


class ModInstallerTests(unittest.TestCase):
    def test_missing_optional_animation_uses_safe_lua_fallback(self) -> None:
        modmain = (Path(__file__).parents[1] / "game-mod" / "modmain.lua").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "local JINGLING_ANIM_AVAILABLE = GLOBAL.kleifileexists",
            modmain,
        )
        self.assertIn("if JINGLING_ANIM_AVAILABLE then", modmain)
        self.assertIn("if not JINGLING_ANIM_AVAILABLE", modmain)

    def test_jingling_uses_render_facing_instead_of_world_rotation(self) -> None:
        modmain = (Path(__file__).parents[1] / "game-mod" / "modmain.lua").read_text(
            encoding="utf-8"
        )

        direction_block = modmain.split("local function get_jingling_direction()", 1)[1].split(
            "local function update_jingling_visual_mode()", 1
        )[0]
        self.assertIn("inst.AnimState:GetCurrentFacing()", direction_block)
        self.assertIn("GLOBAL.FACING_UPLEFT", direction_block)
        self.assertIn("GLOBAL.FACING_DOWNRIGHT", direction_block)
        self.assertNotIn("Transform:GetRotation()", direction_block)

    def test_companion_is_presented_as_xiaotangyuan(self) -> None:
        mod_root = Path(__file__).parents[1] / "game-mod"
        modmain = (mod_root / "modmain.lua").read_text(encoding="utf-8")
        modinfo = (mod_root / "modinfo.lua").read_text(encoding="utf-8")

        self.assertIn('GLOBAL.STRINGS.NAMES.CHESTER = "小汤圆"', modmain)
        self.assertIn('inst.name = "小汤圆"', modmain)
        self.assertIn('label = "小汤圆格数"', modinfo)

    def test_butterfly_skill_uses_server_rpc_and_container_pickup(self) -> None:
        modmain = (Path(__file__).parents[1] / "game-mod" / "modmain.lua").read_text(
            encoding="utf-8"
        )
        self.assertIn('AddModRPCHandler(RPC_NAMESPACE, "skill_atom"', modmain)
        self.assertIn('AddClientModRPCHandler(RPC_NAMESPACE, "skill_result"', modmain)
        self.assertIn('atom == "dst.find_nearest_butterfly"', modmain)
        self.assertIn('target.prefab ~= "butterfly"', modmain)
        self.assertIn('container:GiveItem(current', modmain)

    def test_enables_local_mod_only_once(self) -> None:
        first = enable_modsettings("-- settings\n")
        second = enable_modsettings(first)
        self.assertIn('ForceEnableMod("dont-starve-ai-mod")', first)
        self.assertEqual(first, second)

    def test_adds_world_override_without_replacing_existing_mods(self) -> None:
        original = 'return {\n  ["workshop-1"]={ ["enabled"]=true }\n}'
        updated = enable_modoverride(original)
        self.assertIn('["dont-starve-ai-mod"]', updated)
        self.assertIn('["workshop-1"]', updated)
        self.assertEqual(enable_modoverride(updated), updated)

    def test_installs_launcher_into_detected_game_mod_folder(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "download"
            source.mkdir()
            source_exe = source / "ChesterAI.exe"
            source_exe.write_bytes(b"launcher")
            (source / ".env.example").write_text(
                "HARNESS_GATEWAY_URL=ws://127.0.0.1:32145\n",
                encoding="utf-8",
            )
            game_dir = root / "Don't Starve Together"
            settings = SimpleNamespace(game_dir=game_dir)

            with (
                patch.object(sys, "frozen", True, create=True),
                patch.object(sys, "executable", str(source_exe)),
                patch("dont_starve_ai_mod.mod_installer.ensure_game_mod", return_value=[]),
            ):
                destination, launch_option, _actions = install_player_launcher(settings)

            self.assertEqual(destination, game_dir / "mods" / "dont-starve-ai-mod")
            self.assertEqual((destination / "ChesterAI.exe").read_bytes(), b"launcher")
            self.assertEqual(
                (destination / ".env.example").read_text(encoding="utf-8"),
                "HARNESS_GATEWAY_URL=ws://127.0.0.1:32145\n",
            )
            self.assertEqual(launch_option, f'"{destination / "ChesterAI.exe"}" %command%')
            self.assertEqual(
                (destination / "Steam启动项.txt").read_text(encoding="utf-8"),
                f"{launch_option}\n",
            )

    def test_installs_packaged_animation_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_mod = root / "game-mod"
            source_mod.mkdir()
            (source_mod / "modmain.lua").write_text("-- main", encoding="utf-8")
            (source_mod / "modinfo.lua").write_text("-- info", encoding="utf-8")
            (source_mod / "anim").mkdir()
            (source_mod / "anim" / "jingling.zip").write_bytes(b"animation")
            settings = SimpleNamespace(game_dir=root / "Don't Starve Together")

            with patch("dont_starve_ai_mod.mod_installer.bundled_game_mod_dir", return_value=source_mod):
                ensure_game_mod(settings)

            installed = settings.game_dir / "mods" / "dont-starve-ai-mod" / "anim" / "jingling.zip"
            self.assertEqual(installed.read_bytes(), b"animation")


if __name__ == "__main__":
    unittest.main()
