import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import local_server


class OllamaStub(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        result = {"message": {"content": json.dumps({
            "received": payload["messages"][0]["content"],
            "schema": payload["format"],
            "model": payload["model"],
        })}}
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())


class LocalRoutesTest(unittest.TestCase):
    def server(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_turn_passes_context_and_schema_to_ollama(self):
        ollama = self.server(OllamaStub)
        app = self.server(local_server.Handler)
        schema = {"type": "object"}
        body = {"messages": [{"role": "user", "content": "Mara still has the key."}], "format": schema}
        request = Request(app + "/api/turn", json.dumps(body).encode(), {"Content-Type": "application/json"})
        with patch.object(local_server, "OLLAMA", ollama), urlopen(request, timeout=5) as response:
            result = json.load(response)
        self.assertEqual(result, {"received": "Mara still has the key.", "schema": schema, "model": local_server.MODEL})

    def test_bad_payload_returns_json_error(self):
        app = self.server(local_server.Handler)
        request = Request(app + "/api/image", b"broken", {"Content-Type": "application/json"})
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 400)
        self.assertIn("Invalid request", json.load(error.exception)["error"])


if __name__ == "__main__":
    unittest.main()
