import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dont_starve_ai_mod.app import ChesterApp, build_chat_context, write_reply


class FakeGateway:
    def __init__(self) -> None:
        self.connected = True
        self.notifications: list[tuple[str, dict[str, object]]] = []
        self.calls: list[tuple[str, dict[str, object]]] = []

    def start(self, _process_id: int) -> None:
        pass

    def close(self) -> None:
        pass

    def notify(self, method: str, params: dict[str, object]) -> bool:
        self.notifications.append((method, params))
        return True

    def call(self, method: str, params: dict[str, object], _timeout: float) -> object:
        self.calls.append((method, params))
        return {"reply": "Harness reply"}


class ModRequestTests(unittest.TestCase):
    def make_app(self, root: Path) -> tuple[ChesterApp, FakeGateway]:
        gateway = FakeGateway()
        settings = SimpleNamespace(
            gateway_url="ws://127.0.0.1:33145",
            connection_timeout_seconds=1.0,
            request_timeout_seconds=10.0,
            request_file=root / "requests.json",
            reply_file=root / "reply.json",
            bridge_status_file=root / "bridge_status.json",
            state_file=root / "state.json",
            skill_command_file=root / "skill_command.json",
            skill_result_file=root / "skill_result.json",
        )
        return ChesterApp(settings, gateway=gateway), gateway

    def test_game_atom_bridge_waits_for_matching_lua_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))

            def lua_side() -> None:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    try:
                        command = json.loads(app.settings.skill_command_file.read_text(encoding="utf-8"))
                    except (FileNotFoundError, json.JSONDecodeError):
                        time.sleep(0.01)
                        continue
                    app.settings.skill_result_file.write_text(
                        json.dumps({"id": command["id"], "success": True, "result": {"targetId": 42}}),
                        encoding="utf-8",
                    )
                    return

            worker = threading.Thread(target=lua_side, daemon=True)
            worker.start()
            result = app._on_harness_request(
                "game.atom.execute",
                {"atom": "dst.find_nearest_butterfly", "arguments": {"radius": 20}},
            )
            worker.join(timeout=2)
            self.assertEqual(result, {"targetId": 42})

    def test_reads_new_json_events_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app, _ = self.make_app(root)
            document = {"events": [{"id": "1", "action": "start_recording"}]}
            app.settings.request_file.write_text(json.dumps(document), encoding="utf-8")
            self.assertEqual(len(app._read_mod_requests(app.settings.request_file)), 1)
            self.assertEqual(app._read_mod_requests(app.settings.request_file), [])

    def test_accepts_single_event_json_for_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app, _ = self.make_app(root)
            app.settings.request_file.write_text(
                json.dumps({"id": "1", "action": "start_recording"}),
                encoding="utf-8",
            )
            self.assertEqual(app._read_mod_requests(app.settings.request_file)[0]["action"], "start_recording")

    def test_start_and_stop_publish_state_and_control_harness_recording(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, gateway = self.make_app(Path(directory))
            state = {"player": {"name": "Wilson"}}
            app._handle_mod_request(
                {"action": "start_recording", "state": state, "recipient_userid": "KU_test"}
            )
            app._handle_mod_request({"action": "stop_recording", "state": state})
            self.assertEqual(len(gateway.notifications), 2)
            for method, payload in gateway.notifications:
                self.assertEqual(method, "state.update")
                self.assertEqual(payload["observation"]["schema"], "ai-native.game-context.v1")
                self.assertEqual(payload["observation"]["player"]["name"], "Wilson")
            self.assertEqual(
                gateway.calls,
                [
                    ("voice.start", {}),
                    ("voice.stop", {}),
                ],
            )

    def test_periodic_play_heartbeat_publishes_only_local_state_and_hashed_save_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, gateway = self.make_app(Path(directory))
            state = {"save_id": "KU_world_session", "player": {"name": "Wilson"}}
            app.settings.state_file.write_text(json.dumps(state), encoding="utf-8")
            app._publish_play_heartbeat()
            method, payload = gateway.notifications[0]
            self.assertEqual(method, "state.update")
            self.assertEqual(payload["observation"]["schema"], "ai-native.game-context.v1")
            self.assertEqual(payload["observation"]["player"]["name"], "Wilson")
            self.assertNotIn("KU_world_session", json.dumps(payload["observation"]))
            self.assertEqual(len(payload["saveId"]), 64)
            self.assertNotIn("KU_world_session", payload["saveId"])

    def test_retry_routes_to_harness_in_a_background_thread(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))
            state = {"player": {"name": "Wilson"}}
            with patch("dont_starve_ai_mod.app.threading.Thread") as thread:
                app._handle_mod_request({"action": "retry_last", "state": state})
            self.assertEqual(thread.call_args.kwargs["args"], (state, None))
            self.assertEqual(thread.call_args.kwargs["name"], "chester-harness-retry")
            thread.return_value.start.assert_called_once_with()

    def test_game_reminder_uses_ephemeral_harness_composition(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))
            with patch("dont_starve_ai_mod.app.threading.Thread") as thread:
                app._handle_mod_request(
                    {
                        "action": "game_reminder",
                        "recipient_userid": "KU_test",
                        "reminder": {"kind": "night", "message": "天黑了。"},
                    }
                )
            self.assertEqual(
                thread.call_args.kwargs["args"],
                ("night", "天黑了。", None, "KU_test"),
            )
            self.assertEqual(thread.call_args.kwargs["name"], "chester-harness-reminder")

    def test_harness_present_notification_writes_recipient_reply(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))
            app._active_recipient_userid = "KU_test"
            app._on_harness_notification("assistant.present", {"text": "你好"})
            payload = json.loads(app.settings.reply_file.read_text(encoding="utf-8"))
            self.assertEqual(payload["text"], "你好")
            self.assertEqual(payload["recipient_userid"], "KU_test")

    def test_harness_delta_notification_updates_streaming_reply(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))
            app._active_recipient_userid = "KU_test"
            app._on_harness_notification(
                "assistant.delta",
                {"interactionId": "stream-1", "delta": "好", "text": "你好"},
            )
            payload = json.loads(app.settings.reply_file.read_text(encoding="utf-8"))
            self.assertEqual(payload["text"], "你好")
            self.assertEqual(payload["recipient_userid"], "KU_test")

    def test_bridge_status_identifies_harness_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app, _ = self.make_app(Path(directory))
            app._write_bridge_status(force=True)
            payload = json.loads(app.settings.bridge_status_file.read_text(encoding="utf-8"))
            self.assertEqual(payload["chat_model"], "DeepSeek Harness")
            self.assertTrue(payload["gateway_connected"])
            self.assertEqual(payload["schema_version"], 2)

    def test_builds_structured_harness_context(self) -> None:
        context = build_chat_context(
            {
                "save_id": "KU_world_session",
                "player": {"name": "Wilson"},
                "world": {"cycles": 4, "season": "autumn", "phase": "night"},
                "nearby": [{"prefab": "chester"}],
            }
        )
        self.assertEqual(context["playerName"], "Wilson")
        self.assertEqual(context["date"], "Day 5, autumn")
        self.assertEqual(context["time"], "night")
        self.assertEqual(context["nearbyNpc"], "chester")
        self.assertEqual(len(context["saveId"]), 64)
        self.assertNotIn("KU_world_session", context["saveId"])
        role_instructions = context["roleInstructions"]
        self.assertIn("answer directly when you are confident", role_instructions)
        self.assertIn("never guess", role_instructions)
        self.assertIn("when a web or search tool is available", role_instructions)
        self.assertIn("cannot verify the answer right now", role_instructions)
        self.assertIn("never pretend that you searched", role_instructions)

    def test_write_reply_keeps_recipient_and_duration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.json"
            write_reply(path, "Hello", "KU_test", 12.5)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["recipient_userid"], "KU_test")
            self.assertEqual(payload["display_duration_seconds"], 12.5)


if __name__ == "__main__":
    unittest.main()
