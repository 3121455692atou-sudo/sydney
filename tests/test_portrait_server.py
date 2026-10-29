import importlib.util
import json
import threading
import tempfile
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("portrait_server", Path(__file__).parents[1] / "portrait_server.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class MockModel(BaseHTTPRequestHandler):
    last = None
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"data":[{"id":"sydney-bonsai"}]}')
    def do_POST(self):
        MockModel.last = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        for delta in [{"reasoning_content": "思考"}, {"content": "<l2d>happy</l2d>你好！"}]:
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": delta}]}) + "\n\n").encode())
        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        cls.front = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.remote = ThreadingHTTPServer(("127.0.0.1", 0), app.RemoteHandler)
        cls.front.daemon_threads = True
        cls.remote.daemon_threads = True
        app.API_BASE = f"http://127.0.0.1:{cls.model.server_port}/v1"
        app.KEY_FILE = ""
        for server in (cls.model, cls.front, cls.remote): threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.front.server_port}"
        cls.remote_base = f"http://127.0.0.1:{cls.remote.server_port}"
    @classmethod
    def tearDownClass(cls):
        for server in (cls.model, cls.front, cls.remote): server.shutdown(); server.server_close()
    def request(self, path, body=None, headers=None, remote=False):
        base = self.remote_base if remote else self.base
        return urllib.request.urlopen(urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers or {}), timeout=5)
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.settings_patch = patch.object(app, "SETTINGS_FILE", Path(self.temporary.name) / "settings.json")
        self.settings_patch.start()
    def tearDown(self):
        self.settings_patch.stop()
        self.temporary.cleanup()
    def test_real_stream_bridge(self):
        with self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]}) as response:
            events = [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(events[0], {"reasoning": "思考"})
        self.assertEqual(events[1], {"delta": "<l2d>happy</l2d>你好！"})
        self.assertEqual(events[-1], {"done": True})
        # 没保存过提示词时，默认提示词（sydney_system_prompt.txt）放在最前面
        self.assertEqual(MockModel.last["messages"], [{"role": "system", "content": app.DEFAULT_PROMPT}, {"role": "user", "content": "你好"}])
        self.assertTrue(app.DEFAULT_PROMPT.startswith("# 这是 Sydney 的聊天。"))
        self.assertEqual(app.CHAT_QUEUE.active, 0)
    def test_history_keeps_reasoning_and_drops_system_hint(self):
        history = [{"role": "user", "content": "嗨"}, {"role": "assistant", "content": "<l2d>happy</l2d>你好", "reasoning_content": "用户在打招呼"},
                   {"role": "user", "content": "你好", "reasoning_content": "用户消息不带思考"}]
        with self.request("/api/chat", {"messages": history}) as response: response.read()
        self.assertEqual(MockModel.last["messages"][0]["role"], "system")
        self.assertEqual(MockModel.last["messages"][2]["reasoning_content"], "用户在打招呼")
        self.assertNotIn("reasoning_content", MockModel.last["messages"][3])
        self.assertEqual(MockModel.last["chat_template_kwargs"]["reasoning_effort"], "medium")
    def test_path_traversal(self):
        with self.assertRaises(urllib.error.HTTPError) as error: self.request("/%2e%2e/%2e%2e/portrait_server.py")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
    def test_cross_origin_write(self):
        with self.assertRaises(urllib.error.HTTPError) as error: self.request("/api/chat", {"messages": []}, {"Origin": "https://example.invalid"})
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
    def test_invalid_message_does_not_reach_model(self):
        with self.assertRaises(urllib.error.HTTPError) as error: self.request("/api/chat", {"messages": [{"role": "tool", "content": "bad"}]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
    def test_status_omits_private_config(self):
        with self.request("/api/status") as response: data = json.load(response)
        self.assertTrue(data["ready"])
        self.assertNotIn("api_key", data)
        self.assertNotIn("endpoint", data)
    def test_busy_generation_queues_then_answers(self):
        self.assertTrue(app.CHAT_QUEUE.hold_all())
        try:
            response = self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]})
            self.assertEqual(json.loads(response.readline().decode()[6:]), {"queue": 1})
        finally:
            app.CHAT_QUEUE.release_all()
        with response:
            events = [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(events[0], {"queue": 0})
        self.assertEqual(events[1], {"reasoning": "思考"})
        self.assertEqual(events[-1], {"done": True})
        self.assertEqual(app.CHAT_QUEUE.active, 0)
        self.assertEqual(len(app.CHAT_QUEUE), 0)
    def test_free_slot_answers_without_queueing(self):
        with patch.object(app, "SLOTS", 2):
            other = app.CHAT_QUEUE.join()
            self.assertTrue(app.CHAT_QUEUE.take(other, 0))
            try:
                with self.request("/api/status") as response:
                    self.assertEqual({k: v for k, v in json.load(response).items() if k in ("busy", "active", "slots")}, {"busy": False, "active": 1, "slots": 2})
                with self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]}) as response:
                    events = [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith("data: ")]
                self.assertEqual(events[0], {"reasoning": "思考"})
                self.assertEqual(events[-1], {"done": True})
                self.assertFalse(app.CHAT_QUEUE.hold_all())  # 还有人在生成时不能改设置
            finally:
                app.CHAT_QUEUE.release()
        self.assertEqual(app.CHAT_QUEUE.active, 0)
    def test_image_message_reaches_model(self):
        image = {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQSkZJRg=="}}
        with self.request("/api/chat", {"messages": [{"role": "user", "content": [image, {"type": "text", "text": "这是什么？"}]}]}) as response:
            response.read()
        self.assertEqual(MockModel.last["messages"][-1]["content"], [image, {"type": "text", "text": "这是什么？"}])
        with self.request("/api/chat", {"messages": [{"role": "user", "content": [image]}]}, remote=True) as response:
            response.read()
        self.assertEqual(MockModel.last["messages"][-1]["content"], [image])
    def test_only_inline_images_are_accepted(self):
        for url in ["http://127.0.0.1:8099/secret.png", "file:///etc/passwd", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,abc\""]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/chat", {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}}]}]})
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        too_many = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw=="}}] * 7
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/chat", {"messages": [{"role": "user", "content": too_many}]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
    def test_full_queue_is_rejected(self):
        with patch.object(app, "QUEUE_MAX", 0):
            with self.assertRaises(urllib.error.HTTPError) as error: self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]})
        self.assertEqual(error.exception.code, 409)
        error.exception.close()
    def test_original_stylesheet_is_served_unchanged(self):
        with self.request("/static/app.css") as response:
            self.assertEqual(response.read(), (app.ROOT / "static/app.css").read_bytes())
    def test_network_scope_applies_to_reads_and_writes(self):
        with patch.object(app, "ALLOWED_NETWORKS", (app.ipaddress.ip_network("192.0.2.0/24"),)):
            for path, body in [("/health", None), ("/api/chat", {"messages": [{"role": "user", "content": "你好"}]})]:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.request(path, body)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
    def test_original_settings_controls_reach_model(self):
        with self.request("/api/settings", {"action": "save", "prompt": "测试提示词", "thinking": False, "preset": "8g"}) as response:
            self.assertTrue(json.load(response)["ok"])
        with self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]}) as response:
            response.read()
        self.assertEqual(MockModel.last["messages"][0], {"role": "system", "content": "测试提示词"})
        self.assertFalse(MockModel.last["chat_template_kwargs"]["enable_thinking"])
        self.assertEqual(MockModel.last["max_tokens"], 1024)
        self.assertEqual(app.read_settings()["prompt"], "测试提示词")
    def test_model_controls_only_target_fixed_service(self):
        with patch.object(app.subprocess, "run") as run:
            with self.request("/api/settings", {"action": "unload"}) as response:
                self.assertTrue(json.load(response)["ok"])
            self.assertEqual(run.call_args.args[0], ["systemctl", "--user", "stop", "sydney-portrait-model.service"])
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/settings", {"action": "load", "adapter": "unexpected-model"})
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            self.assertEqual(run.call_count, 1)

    def test_remote_thinking_is_per_request_and_leaves_shared_settings(self):
        app.save_settings({"thinking": True, "prompt": "保留本机提示词", "preset": "8g"})
        with self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}], "thinking": False}, remote=True) as response:
            self.assertIn('"done": true', response.read().decode())
        self.assertFalse(MockModel.last["chat_template_kwargs"]["enable_thinking"])
        self.assertEqual(MockModel.last["messages"][0]["content"], "保留本机提示词")
        self.assertEqual(app.read_settings(), {"thinking": True, "prompt": "保留本机提示词", "preset": "8g"})
        with self.request("/api/chat", {"messages": [{"role": "user", "content": "你好"}]}, remote=True) as response:
            response.read()
        self.assertTrue(MockModel.last["chat_template_kwargs"]["enable_thinking"])

    def test_remote_cannot_change_other_settings_even_with_local_host_header(self):
        original = app.read_settings()
        bodies = [
            {"action": "load", "adapter": app.MODEL},
            {"action": "unload"},
            {"action": "save", "prompt": "禁止写入"},
            {"action": "save", "preset": "8g"},
            {"action": "save", "thinking": False},
            {"action": "save", "thinking": False, "adapter": app.MODEL},
            {"action": "save", "thinking": False, "prompt": "禁止写入"},
        ]
        with patch.object(app.subprocess, "run") as run:
            for body in bodies:
                with self.subTest(body=body), self.assertRaises(urllib.error.HTTPError) as error:
                    self.request("/api/settings", body, {"Host": "127.0.0.1:8765"}, remote=True)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
            run.assert_not_called()
        self.assertEqual(app.read_settings(), original)

    def test_settings_advertise_permissions_of_each_listener(self):
        with patch.object(app, "settings_snapshot", return_value={"thinking": True}):
            for remote in (False, True):
                with self.request("/api/settings", remote=remote) as response:
                    self.assertEqual(json.load(response)["remote_settings_only"], remote)


if __name__ == "__main__": unittest.main()
