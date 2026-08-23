from __future__ import annotations

import json
import logging
import queue
import threading
import uuid
from collections.abc import Callable
from typing import Any

import websocket


LOGGER = logging.getLogger("chester")


class HarnessUnavailable(RuntimeError):
    pass


class HarnessRpcError(RuntimeError):
    pass


class HarnessClient:
    """Small reconnecting JSON-RPC client for the local DeepSeek Harness Gateway."""

    def __init__(
        self,
        url: str,
        *,
        adapter_id: str,
        game_id: str,
        version: str,
        on_notification: Callable[[str, dict[str, Any]], None],
        on_request: Callable[[str, dict[str, Any]], Any] | None = None,
        connect_timeout: float = 3.0,
    ) -> None:
        self.url = url
        self.adapter_id = adapter_id
        self.game_id = game_id
        self.version = version
        self.on_notification = on_notification
        self.on_request = on_request
        self.connect_timeout = connect_timeout
        self._process_id: int | None = None
        self._socket: websocket.WebSocket | None = None
        self._socket_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._connected = threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def start(self, process_id: int) -> None:
        if process_id <= 0:
            raise ValueError("process_id must be positive")
        self._process_id = process_id
        if self._thread is not None and self._thread.is_alive():
            return
        self._stopping.clear()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="chester-harness-gateway",
        )
        self._thread.start()

    def wait_until_connected(self, timeout: float | None = None) -> bool:
        return self._connected.wait(self.connect_timeout if timeout is None else timeout)

    def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                socket = websocket.create_connection(
                    self.url,
                    timeout=self.connect_timeout,
                    enable_multithread=True,
                )
                socket.settimeout(1.0)
                with self._socket_lock:
                    self._socket = socket
                self._send_payload(
                    {
                        "jsonrpc": "2.0",
                        "method": "adapter.hello",
                        "params": {
                            "adapterId": self.adapter_id,
                            "gameId": self.game_id,
                            "version": self.version,
                            "protocolVersion": "1.1",
                            "capabilities": [
                                "assistant.text-stream",
                                "dst.find_nearest_butterfly",
                                "dst.attack_butterfly",
                                "dst.collect_butterfly_loot",
                            ],
                            "atoms": [
                                {
                                    "name": "dst.find_nearest_butterfly",
                                    "description": "在玩家附近寻找最近的活蝴蝶，不移动也不攻击",
                                    "parameters": '{"radius": 2到25的搜索半径}',
                                    "returns": '{"targetId": 蝴蝶实体ID, "x": 数字, "z": 数字}',
                                },
                                {
                                    "name": "dst.attack_butterfly",
                                    "description": "让小汤圆追击指定蝴蝶并攻击一次",
                                    "parameters": '{"targetId": 来自寻找原子的蝴蝶实体ID}',
                                    "returns": '{"targetId": 实体ID, "defeated": true, "x": 击杀位置, "z": 击杀位置}',
                                },
                                {
                                    "name": "dst.collect_butterfly_loot",
                                    "description": "让小汤圆到指定位置附近拾取蝴蝶翅膀或黄油并放入容器",
                                    "parameters": '{"x": 数字, "z": 数字, "radius": 1到8的搜索半径}',
                                    "returns": '{"count": 拾取数量, "items": 物品prefab数组}',
                                },
                            ],
                            "processId": self._process_id,
                        },
                    }
                )
                self._connected.set()
                LOGGER.info("已连接 DeepSeek Harness：%s", self.url)
                self._receive_loop(socket)
            except Exception as exc:
                if not self._stopping.is_set():
                    LOGGER.warning("DeepSeek Harness 暂不可用：%s", exc)
            finally:
                self._disconnect()
            if not self._stopping.wait(2.0):
                continue

    def _receive_loop(self, socket: websocket.WebSocket) -> None:
        while not self._stopping.is_set():
            try:
                raw = socket.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if raw is None or raw == "":
                raise HarnessUnavailable("Gateway 已关闭连接")
            message = json.loads(raw)
            if not isinstance(message, dict):
                continue
            request_id = message.get("id")
            method = message.get("method")
            params = message.get("params")
            if isinstance(request_id, (str, int)) and isinstance(method, str):
                request_params = params if isinstance(params, dict) else {}
                threading.Thread(
                    target=self._handle_server_request,
                    args=(request_id, method, request_params),
                    daemon=True,
                    name="chester-harness-server-request",
                ).start()
                continue
            if isinstance(request_id, (str, int)):
                with self._pending_lock:
                    pending = self._pending.get(str(request_id))
                if pending is not None:
                    pending.put(message)
                continue
            if isinstance(method, str) and isinstance(params, dict):
                try:
                    self.on_notification(method, params)
                except Exception:
                    LOGGER.exception("处理 Harness 通知失败：%s", method)

    def _handle_server_request(
        self,
        request_id: str | int,
        method: str,
        params: dict[str, Any],
    ) -> None:
        try:
            if self.on_request is None:
                raise HarnessRpcError(f"Adapter 不支持 Harness 请求：{method}")
            result = self.on_request(method, params)
            self._send_payload({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as exc:
            LOGGER.exception("处理 Harness 请求失败：%s", method)
            try:
                self._send_payload(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32010, "message": str(exc)},
                    }
                )
            except Exception:
                LOGGER.exception("发送 Harness 请求错误结果失败：%s", method)

    def _send_payload(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._socket_lock:
            socket = self._socket
            if socket is None or not socket.connected:
                raise HarnessUnavailable("尚未连接 DeepSeek Harness")
            socket.send(encoded)

    def notify(self, method: str, params: dict[str, Any]) -> bool:
        if not self.connected:
            return False
        try:
            self._send_payload({"jsonrpc": "2.0", "method": method, "params": params})
            return True
        except Exception:
            return False

    def call(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        if not self.wait_until_connected():
            raise HarnessUnavailable("DeepSeek Harness 未启动或游戏插件未启用")
        request_id = str(uuid.uuid4())
        response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = response_queue
        try:
            self._send_payload(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
            try:
                response = response_queue.get(timeout=timeout)
            except queue.Empty as exc:
                raise HarnessUnavailable(f"Harness 请求超时：{method}") from exc
            error = response.get("error")
            if isinstance(error, dict):
                raise HarnessRpcError(str(error.get("message") or "Harness 请求失败"))
            return response.get("result")
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def _disconnect(self) -> None:
        self._connected.clear()
        with self._socket_lock:
            socket = self._socket
            self._socket = None
        if socket is not None:
            try:
                socket.close()
            except Exception:
                pass
        failure = {
            "jsonrpc": "2.0",
            "error": {"code": -32001, "message": "与 DeepSeek Harness 的连接已断开"},
        }
        with self._pending_lock:
            pending = list(self._pending.values())
        for response_queue in pending:
            try:
                response_queue.put_nowait(failure)
            except queue.Full:
                pass

    def close(self) -> None:
        self._stopping.set()
        self._disconnect()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
