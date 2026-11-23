import io
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


    def test_hanging_a_coat_drops_only_conflicting_wardrobe(self):
        scene = {"action": "Hangs wet coat", "wardrobe": "Wearing a navy-blue trench coat and a burgundy sweater"}
        action, wardrobe = local_server.art_action_and_wardrobe(scene)
        self.assertEqual(action, "Hangs wet coat on a hook")
        self.assertEqual(wardrobe, "a burgundy sweater")
        scene["wardrobe"] = "Wearing a navy-blue trench coat"
        self.assertEqual(local_server.art_action_and_wardrobe(
            scene, "Tan raincoat over a burgundy sweater"
        )[1], "a burgundy sweater")
        scene["action"] = "Sits on the floor"
        self.assertEqual(local_server.art_action_and_wardrobe(scene), (scene["action"], scene["wardrobe"]))

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


class ModelReviewTest(unittest.TestCase):
    def test_incomplete_model_json_retries_with_stricter_format(self):
        def response(content):
            return io.BytesIO(json.dumps({"message": {"content": content}}).encode())

        with patch.object(local_server, "urlopen", side_effect=[
            response('{"prose": "unfinished'),
            response('```json\n{"prose": "Mara looks around the apartment."}\n```'),
        ]) as send:
            result = local_server.ollama_json("qwen3:4b", [{"role": "user", "content": "Continue."}],
                                             {"required": ["prose"]}, {"temperature": 0.75})
        self.assertEqual(result["prose"], "Mara looks around the apartment.")
        self.assertEqual(send.call_count, 2)
        self.assertEqual(json.loads(send.call_args.args[0].data)["options"]["temperature"], 0.2)

    def test_arrival_anchors_scene_before_story_review(self):
        context = {"playerEntry": "You take Mara to your apartment.", "playerDestination": "Your apartment",
                   "playerCompanion": "mara", "scene": {"wardrobe": "Red sweater"}}
        source = {"prose": "Mara glances at the doorway.", "scene": {"location": "The Breakwater Diner",
                  "focus": "none", "action": "Sits at the booth", "details": "Two coffee cups"}}
        with patch.object(local_server, "ollama_json", return_value=source), \
             patch.object(local_server, "STORY_REVIEW", True), \
             patch.object(local_server, "review_story", return_value=(True, "")) as reviewer:
            result = local_server.narrate({"messages": [{"content": json.dumps(context)}], "format": {}})
        scene = reviewer.call_args.args[1]["scene"]
        self.assertEqual(scene["location"], "Your apartment")
        self.assertEqual(scene["focus"], "mara")
        self.assertEqual(scene["action"], "")
        self.assertEqual(result["scene"]["wardrobe"], "Red sweater")

    def test_arrival_recovers_when_model_cannot_produce_a_valid_turn(self):
        context = {"playerEntry": "You take Mara to your apartment.", "playerDestination": "Your apartment",
                   "playerCompanion": "mara", "cast": [{"id": "mara", "name": "Mara Venn"}],
                   "scene": {"location": "Your apartment", "focus": "mara", "action": ""},
                   "facts": ["The brass key opens locker seventeen."]}
        messages = [{"role": "system", "content": "Narrate."},
                    {"role": "user", "content": json.dumps(context)}]
        draft = {"prose": "Mara stays at the diner.", "scene": context["scene"].copy()}
        verdict = {"passes": False, "reason": "Wrong setting."}
        with patch.object(local_server, "STORY_REVIEW", True):
            for replies in ([local_server.IncompleteModelOutput("Truncated.")], [draft, verdict, draft, verdict]):
                with patch.object(local_server, "ollama_json", side_effect=replies):
                    result = local_server.narrate({"messages": messages, "format": {}})
                self.assertEqual(result["prose"], "Mara Venn pauses to take in the room.")
                self.assertEqual(result["scene"]["location"], "Your apartment")
                self.assertEqual(result["scene"]["focus"], "mara")
                self.assertEqual(result["facts"], context["facts"])
                self.assertEqual(result["stateChanges"], [])

    def test_story_retries_with_the_review_reason(self):
        messages = [{"role": "system", "content": "Narrate."},
                    {"role": "user", "content": json.dumps({"playerEntry": "You take the key."})}]
        wrong = {"prose": "Mara still holds the key."}
        right = {"prose": "The key is cold in your palm."}
        with patch.object(local_server, "STORY_REVIEW", True), \
             patch.object(local_server, "ollama_json", side_effect=[
                 wrong, {"passes": False, "reason": "The player already has the key."},
                 right, {"passes": True, "reason": ""},
             ]) as chat:
            self.assertEqual(local_server.narrate({"messages": messages, "format": {}}), right)
        self.assertIn("The player already has the key", chat.call_args_list[2].args[1][0]["content"])
        self.assertEqual(messages[0]["content"], "Narrate.")

    def test_failed_story_review_does_not_return_a_turn(self):
        messages = [{"role": "user", "content": json.dumps({"playerEntry": "You take the key."})}]
        draft = {"prose": "Mara still holds the key."}
        verdict = {"passes": False, "reason": "Wrong holder."}
        with patch.object(local_server, "STORY_REVIEW", True), \
             patch.object(local_server, "ollama_json", side_effect=[draft, verdict, draft, verdict]):
            with self.assertRaisesRegex(RuntimeError, "Wrong holder"):
                local_server.narrate({"messages": messages, "format": {}})

    def test_blind_observation_rejects_wrong_count_and_worn_coat(self):
        data = {"scene": {"action": "Hangs a wet raincoat on a wall hook", "wardrobe": "Burgundy sweater"}}
        with patch.object(local_server, "ollama_json") as compare:
            self.assertFalse(local_server.compare_image_observation(data, {"people": 0})[0])
            verdict = local_server.compare_image_observation(data, {"people": 1, "wearing": "A tan trench coat"})
            self.assertEqual(verdict, (False, "The garment to hang is still being worn."))
            compare.assert_not_called()

    def test_image_review_retries_and_keeps_only_the_accepted_render(self):
        with patch.object(local_server, "VISION_MODEL", "vision"), \
             patch.object(local_server, "illustrate", side_effect=[{"image": "plant"}, {"image": "person"}]) as render, \
             patch.object(local_server, "release_image_pipeline"), \
             patch.object(local_server, "review_image", side_effect=[(False, "No person."), (True, "")]):
            result = local_server.render_checked_image({"seed": 11})
        self.assertEqual(result, {"image": "person", "reviewed": True})
        self.assertEqual([call.args[0]["seed"] for call in render.call_args_list], [11, 12])

    def test_two_rejected_images_do_not_return_an_image(self):
        with patch.object(local_server, "VISION_MODEL", "vision"), \
             patch.object(local_server, "illustrate", return_value={"image": "plant"}), \
             patch.object(local_server, "release_image_pipeline"), \
             patch.object(local_server, "review_image", return_value=(False, "No person.")):
            with self.assertRaisesRegex(RuntimeError, "No person"):
                local_server.render_checked_image({})

    def test_unconfigured_vision_returns_an_unreviewed_render(self):
        with patch.object(local_server, "VISION_MODEL", ""), \
             patch.object(local_server, "illustrate", return_value={"image": "person"}):
            self.assertEqual(local_server.render_checked_image({}), {"image": "person", "reviewed": False})


if __name__ == "__main__":
    unittest.main()
