import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch
from types import SimpleNamespace

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


class ScenePromptTest(unittest.TestCase):
    def test_both_tokenizers_keep_action_and_location_in_budget(self):
        class Tokenizer:
            model_max_length = 77

            def __init__(self, tokens_per_word):
                self.tokens_per_word = tokens_per_word

            def __call__(self, text, add_special_tokens=True, verbose=False):
                count = len(text.split()) * self.tokens_per_word + (2 if add_special_tokens else 0)
                return SimpleNamespace(input_ids=[0] * count)

        tokenizers = (Tokenizer(1), Tokenizer(2))
        scene = {
            "action": "Walks down the apartment steps",
            "location": "Rainy apartment entrance",
            "details": "White knuckles on a brass key, " + "extra " * 50,
            "appearance": "Dark bob",
        }
        prompt = local_server.scene_prompt(scene, tokenizers)
        for fragment in ("Walks down the apartment steps", "Rainy apartment entrance", "Dark bob"):
            self.assertIn(fragment, prompt)
        self.assertNotIn("White knuckles", prompt)
        for tokenizer in tokenizers:
            self.assertLessEqual(len(tokenizer(prompt).input_ids), tokenizer.model_max_length)


    def test_unweighted_comparison_uses_the_same_negative_groups(self):
        result = local_server.negative_conditioning(None, weighted=False)
        self.assertIn("collage", result["negative_prompt"])
        self.assertIn("malformed hands", result["negative_prompt"])

    @unittest.skipUnless(os.environ.get("NIGHTDRAFT_REAL_TOKENIZERS"), "requires the model-test environment")
    def test_weighted_negative_conditioning_blends_token_and_pooled_embeddings(self):
        import numpy as np

        class Pipeline:
            def encode_prompt(self, prompts, do_classifier_free_guidance):
                self.prompts = prompts
                return np.array([[0], [2], [4]]), None, np.array([[1], [3], [5]]), None

        pipe = Pipeline()
        conditioning = local_server.negative_conditioning(pipe)
        self.assertAlmostEqual(conditioning["negative_prompt_embeds"].item(), 3.75)
        self.assertAlmostEqual(conditioning["negative_pooled_prompt_embeds"].item(), 4.75)
        self.assertIn("malformed hands", pipe.prompts[2])

    @unittest.skipUnless(os.environ.get("NIGHTDRAFT_REAL_TOKENIZERS"), "requires SDXL tokenizer files")
    def test_reported_apartment_prompt_with_real_sdxl_tokenizers(self):
        from transformers import CLIPTokenizer

        root = os.environ["NIGHTDRAFT_REAL_TOKENIZERS"]
        tokenizers = tuple(CLIPTokenizer.from_pretrained(os.path.join(root, name))
                           for name in ("tokenizer", "tokenizer_2"))
        scene = {
            "action": "Looks down holding a brass key",
            "location": "Inside the apartment hallway",
            "viewpoint": "low",
            "appearance": "Adult woman with olive skin and a short dark bob",
            "details": "Her short dark bob is damp, the burgundy sweater lies discarded on the floor, "
                       "and the dim hallway light casts long shadows across the wet floor",
        }
        self.assertEqual(local_server.scene_prompt(scene, tokenizers, "naked"), "naked")
        with self.assertRaisesRegex(ValueError, "Shorten"):
            local_server.scene_prompt(scene, tokenizers, "very " * 90)
        for wardrobe in ("", "Undressed adult"):
            prompt = local_server.scene_prompt({**scene, "wardrobe": wardrobe}, tokenizers)
            self.assertNotIn("burgundy sweater", prompt)
            self.assertIn(scene["action"], prompt)
            self.assertIn(scene["location"], prompt)
            self.assertIn("low-angle view", prompt)
            if wardrobe:
                self.assertIn("Naked,", prompt)
                self.assertNotIn("Naked adult", prompt)
            for tokenizer in tokenizers:
                self.assertLessEqual(len(tokenizer(prompt).input_ids), tokenizer.model_max_length)


if __name__ == "__main__":
    unittest.main()
