import json
from pathlib import Path
import tempfile
import unittest

from dont_starve_ai_mod.game_state import build_context, read_game_state


class GameStateTests(unittest.TestCase):
    def test_reads_lua_state_and_builds_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({"player": {"prefab": "wilson"}}), encoding="utf-8")
            state = read_game_state(path)
            context = build_context(state, {"title": "Don't Starve Together"})

        self.assertTrue(state["available"])
        self.assertEqual(context["mod_state"]["data"]["player"]["prefab"], "wilson")

    def test_missing_state_degrades_gracefully(self) -> None:
        state = read_game_state(Path("definitely-missing.json"), attempts=1)
        self.assertFalse(state["available"])


if __name__ == "__main__":
    unittest.main()
