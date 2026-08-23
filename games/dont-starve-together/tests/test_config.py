from pathlib import Path
from unittest.mock import patch
import unittest

from dont_starve_ai_mod.config import Settings, _env, parse_steam_library_paths


class SteamLibraryParsingTests(unittest.TestCase):
    def test_parses_and_deduplicates_paths(self) -> None:
        text = r'''
        "0" { "path" "E:\\steam" }
        "1" { "path" "D:\\SteamLibrary" }
        "2" { "path" "E:\\steam" }
        '''
        self.assertEqual(
            parse_steam_library_paths(text),
            [Path(r"E:\steam"), Path(r"D:\SteamLibrary")],
        )

    def test_blank_optional_url_uses_default(self) -> None:
        with patch.dict("os.environ", {"CHAT_URL": ""}):
            self.assertEqual(_env("CHAT_URL", "https://example.test/chat"), "https://example.test/chat")

    def test_rejects_non_loopback_harness_gateway(self) -> None:
        settings = Settings(
            gateway_url="ws://example.com:32145",
            connection_timeout_seconds=3,
            request_timeout_seconds=120,
            game_dir=None,
            state_file=None,
            reply_file=Path("reply.json"),
            request_file=Path("requests.json"),
            bridge_status_file=None,
            skill_command_file=Path("skill-command.json"),
            skill_result_file=Path("skill-result.json"),
            runtime_dir=Path("runtime"),
        )
        self.assertIn("本机", settings.configuration_errors()[0])


if __name__ == "__main__":
    unittest.main()
