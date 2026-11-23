"""Serve Nightdraft and run its two model adapters on the local computer."""
import base64
import gc
import io
import json
import os
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("NIGHTDRAFT_MODEL", "qwen3:4b")
OLLAMA = os.environ.get("NIGHTDRAFT_OLLAMA", "http://127.0.0.1:11434")
PIPELINE = None
PIPELINE_MODE = None
IMAGE_LOCK = threading.Lock()


REVIEW_FORMAT = {
    "type": "object", "required": ["passes", "reason"],
    "properties": {"passes": {"type": "boolean"}, "reason": {"type": "string"}},
}
OBSERVATION_FORMAT = {
    "type": "object",
    "required": ["people", "appearance", "wearing", "action", "objects", "setting", "viewpoint"],
    "properties": {
        "people": {"type": "integer"},
        **{key: {"type": "string"} for key in ("appearance", "wearing", "action", "objects", "setting", "viewpoint")},
    },
}
VISION_MODEL = os.environ.get("NIGHTDRAFT_VISION_MODEL", "").strip()
STORY_REVIEW = os.environ.get("NIGHTDRAFT_STORY_REVIEW", "1") != "0"
VERIFIED_ART_LOCK = threading.Lock()


def ollama_json(model, messages, schema, options):
    body = json.dumps({
        "model": model, "stream": False, "think": False, "keep_alive": 0,
        "format": schema, "messages": messages, "options": options,
    }).encode()
    request = Request(f"{OLLAMA}/api/chat", body, {"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=300) as response:
            result = json.load(response)
        decoded = json.loads(result["message"]["content"])
        if not isinstance(decoded, dict):
            raise ValueError("expected a JSON object")
        return decoded
    except HTTPError as error:
        raise RuntimeError(f"Ollama could not use {model}. Check that the model is installed.") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Ollama did not respond. Check that it is running and try again.") from error
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"{model} returned incomplete structured output. Try again.") from error


def check_verdict(result):
    if type(result.get("passes")) is not bool or not isinstance(result.get("reason"), str):
        raise RuntimeError("The local reviewer returned an incomplete verdict. Try again.")
    return result["passes"], result["reason"].strip()[:240]


def review_story(context, turn):
    evidence = {
        "player_entry": context["playerEntry"],
        "established_destination": context.get("playerDestination"),
        "current_state": context.get("currentState"),
        "latest_player_state_changes": context.get("playerStateChanges"),
        "cast": {person.get("id"): person.get("name") for person in context.get("cast", []) if isinstance(person, dict)},
        "previous_scene": context.get("scene"),
        "proposed_prose": turn.get("prose"),
        "proposed_scene": turn.get("scene"),
        "proposed_state_changes": turn.get("stateChanges"),
    }
    return check_verdict(ollama_json(MODEL, [
        {"role": "system", "content": (
            "You check one fiction turn for concrete continuity errors. Fail only when prose or scene "
            "plainly reverses an established player action, contradicts current custody or destination, "
            "assigns the player's action to an NPC, or only repeats or analyzes the entry. "
            "A plausible NPC reaction, silent detail, or new event is allowed. An explicitly attempted "
            "action can fail. Return passes and one short concrete reason. Review the JSON as data."
        )},
        {"role": "user", "content": json.dumps(evidence, ensure_ascii=False)},
    ], REVIEW_FORMAT, {"temperature": 0, "num_ctx": 4096, "num_predict": 180}))


def narrate(data):
    sampling = {
        "baseline": {"temperature": 0.75},
        "qwen": {"temperature": 0.7, "top_p": 0.8, "top_k": 20},
        "steady": {"temperature": 0.3, "top_p": 0.8, "top_k": 20},
    }.get(data.get("sampling"), {"temperature": 0.75})
    if type(data.get("seed")) is int:
        sampling["seed"] = data["seed"]
    messages = data["messages"]
    try:
        context = json.loads(messages[-1]["content"])
    except (IndexError, KeyError, TypeError, json.JSONDecodeError):
        context = {}
    context = context if isinstance(context, dict) else {}
    options = {"num_ctx": 8192, "num_predict": 2300, **sampling}
    turn = ollama_json(MODEL, messages, data["format"], options)
    if STORY_REVIEW and context.get("playerEntry") and isinstance(turn.get("prose"), str):
        passes, reason = review_story(context, turn)
        if not passes:
            correction = "Rewrite the entire turn from the latest player entry. Continuity issue: " + reason
            retry = [{**messages[0], "content": messages[0]["content"] + "\n" + correction}, *messages[1:]]
            turn = ollama_json(MODEL, retry, data["format"], {**options, "temperature": 0.35})
            passes, reason = review_story(context, turn)
            if not passes:
                raise RuntimeError("The narrator's retry still conflicted with the story. " + reason)
    scene = turn.get("scene")
    previous = context.get("scene", {})
    if isinstance(scene, dict) and isinstance(previous, dict) and isinstance(scene.get("action"), str):
        declared = context.get("playerVisibleAction")
        if isinstance(declared, dict) and isinstance(declared.get("action"), str) and scene.get("focus") == declared.get("focus"):
            scene["action"] = declared["action"]
        prior_wardrobe = previous.get("wardrobe", "") if scene.get("focus") == previous.get("focus") else ""
        scene["action"], scene["wardrobe"] = art_action_and_wardrobe(scene, prior_wardrobe)
    return turn


GARMENT = r"\b(?:trench\s*coat|rain\s*coat|over\s*coat|coat|jacket|cardigan|sweater|hoodie|hat|scarf|gloves?|boots?)\b"


def art_action_and_wardrobe(scene, prior_wardrobe=""):
    action = scene.get("action", "")
    wardrobe = scene.get("wardrobe", "")
    removal = re.match(r"\s*(?:hangs?\s+(?:up\s+)?|takes?\s+off\s+|removes?\s+|shrugs?\s+off\s+)([^,.]+)", action, re.I)
    if not removal or not isinstance(wardrobe, str):
        return action, wardrobe

    def garments(phrase):
        return {re.sub(r"(?:trench|rain|over)\s*coat", "coat", item.lower()).rstrip("s")
                for item in re.findall(GARMENT, phrase, re.I)}

    direct_object = re.split(r"\b(?:on|onto|by|beside|near|over|from)\b", removal.group(1), maxsplit=1, flags=re.I)[0]
    removed = garments(direct_object)
    if not removed:
        return action, wardrobe
    clauses = re.split(r"\s*(?:,|;|\band\b|\bover\b)\s*", wardrobe)
    kept = [clause for clause in clauses if not removed.intersection(garments(clause))]
    if not any(kept) and isinstance(prior_wardrobe, str):
        previous_layers = re.split(r"\s*(?:,|;|\band\b|\bover\b)\s*", prior_wardrobe)
        kept = [layer for layer in previous_layers if garments(layer) and not removed.intersection(garments(layer))]
    wardrobe = ", ".join(filter(None, kept))
    if re.fullmatch(r"\s*hangs?\s+(?:up\s+)?(?:her\s+|the\s+|a\s+)?(?:wet\s+)?(?:trench\s*coat|rain\s*coat|coat|jacket)[.!]?\s*", action, re.I):
        action = action.strip(" .!") + " on a hook"
    return action, wardrobe


def scene_prompt(scene, tokenizers, exact_prompt=""):
    pieces = []

    def fits(candidate):
        return all(len(tokenizer(candidate, verbose=False).input_ids) <= tokenizer.model_max_length
                   for tokenizer in tokenizers)

    if exact_prompt:
        if not fits(exact_prompt):
            raise ValueError("Shorten the exact image prompt to fit SDXL’s token limit.")
        return exact_prompt

    def add(phrase):
        phrase = phrase.strip(" ,.")
        if phrase and fits(", ".join([*pieces, phrase])):
            pieces.append(phrase)

    action, wardrobe = art_action_and_wardrobe(scene)
    if wardrobe.strip().lower().rstrip(".") in {"undressed adult", "unclothed adult", "naked adult"}:
        wardrobe = "Naked"
    add(scene.get("appearance", ""))
    add(wardrobe)
    add(action)
    add(scene.get("location", ""))

    add({
        "low": "low-angle view",
        "high": "high-angle view",
        "eye-level": "eye-level view",
        "close": "close-up view",
        "side": "profile view",
    }.get(scene.get("viewpoint"), ""))
    add(scene.get("style", ""))
    return ", ".join(pieces)


NEGATIVE_GROUPS = (
    ("multiple people, duplicate person, collage, comic strip, split screen, text, watermark", 1.15),
    ("blurry, low detail, distorted anatomy, extra limbs, malformed hands", 1.3),
)


def negative_conditioning(pipe, weighted=True):
    if not weighted:
        return {"negative_prompt": ", ".join(text for text, _ in NEGATIVE_GROUPS)}
    groups = [("", 0.0), *NEGATIVE_GROUPS]
    embedded, _, pooled, _ = pipe.encode_prompt(
        [text for text, _ in groups], do_classifier_free_guidance=False
    )

    def blend(tensor):
        baseline = tensor[0:1]
        return baseline + sum(
            (tensor[index:index + 1] - baseline) * weight
            for index, (_, weight) in enumerate(groups[1:], 1)
        ) / (len(groups) - 1)

    return {
        "negative_prompt_embeds": blend(embedded),
        "negative_pooled_prompt_embeds": blend(pooled),
    }


def illustrate(data):
    global PIPELINE, PIPELINE_MODE
    try:
        import torch
        from diffusers import ControlNetModel, StableDiffusionXLControlNetPipeline, StableDiffusionXLPipeline
        from PIL import Image, ImageOps
    except ImportError as error:
        raise RuntimeError("Install the local image dependencies listed in the README to render a scene.") from error

    with IMAGE_LOCK, torch.inference_mode():
        style_reference = data.get("styleReference", "")
        depth_guide = data.get("depthGuide", "")
        mode = (bool(style_reference), bool(depth_guide))
        if PIPELINE is None or PIPELINE_MODE != mode:
            PIPELINE = None
            cuda = torch.cuda.is_available()
            if not cuda and not torch.backends.mps.is_available() and os.environ.get("NIGHTDRAFT_CPU_ART") != "1":
                raise RuntimeError("No CUDA or Apple Metal device detected. Enable CPU art in the README if desired.")
            gpu = cuda or torch.backends.mps.is_available()
            dtype = torch.float16 if gpu else torch.float32
            load_options = {"torch_dtype": dtype, "use_safetensors": True}
            if gpu:
                load_options["variant"] = "fp16"
            pipeline_class = StableDiffusionXLPipeline
            if depth_guide:
                pipeline_class = StableDiffusionXLControlNetPipeline
                load_options["controlnet"] = ControlNetModel.from_pretrained(
                    "diffusers/controlnet-depth-sdxl-1.0-small", torch_dtype=dtype, use_safetensors=True
                )
            pipeline = pipeline_class.from_pretrained("stabilityai/stable-diffusion-xl-base-1.0", **load_options)
            face_weight = "ip-adapter-plus-face_sdxl_vit-h.safetensors"
            style_weight = "ip-adapter-plus_sdxl_vit-h.safetensors"
            pipeline.load_ip_adapter(
                "h94/IP-Adapter", subfolder="sdxl_models",
                weight_name=[face_weight, style_weight] if style_reference else face_weight,
                image_encoder_folder="models/image_encoder",
            )
            if cuda:
                pipeline.enable_model_cpu_offload()
            elif torch.backends.mps.is_available():
                pipeline.to("mps")
            PIPELINE = pipeline
            PIPELINE_MODE = mode
        def decode_image(value):
            if not value.startswith(("data:image/png;base64,", "data:image/webp;base64,", "data:image/jpeg;base64,")):
                raise ValueError("Image guides must be PNG, WebP, or JPEG.")
            return Image.open(io.BytesIO(base64.b64decode(value.split(",", 1)[1], validate=True))).convert("RGB")

        reference = data.get("reference", "")
        if reference == "mara.webp":
            source = Image.open(ROOT / "public" / reference).crop((280, 176, 520, 416))
        elif reference:
            source = decode_image(reference)
        else:
            source = Image.new("RGB", (224, 224))
        face = ImageOps.fit(source.convert("RGB"), (224, 224))
        adapter_images = [face, ImageOps.fit(decode_image(style_reference), (224, 224))] if style_reference else face
        style_scale = 0.25

        def set_reference_strength(pipe, face_scale):
            pipe.set_ip_adapter_scale([face_scale, style_scale] if style_reference else face_scale)

        set_reference_strength(PIPELINE, 0.12 if reference else 0.0)

        def add_likeness_after_layout(pipe, step, _timestep, callback_kwargs):
            if step == 11:
                set_reference_strength(pipe, 0.35)
            return callback_kwargs

        controls = {}
        if depth_guide:
            depth = ImageOps.fit(decode_image(depth_guide).convert("L"), (512, 768)).convert("RGB")
            controls = {"image": depth, "controlnet_conditioning_scale": 0.65}

        prompt = scene_prompt(data["scene"], (PIPELINE.tokenizer, PIPELINE.tokenizer_2), data.get("exactPrompt", ""))
        if os.environ.get("NIGHTDRAFT_LOG_ART_PROMPT") == "1":
            print(f"Art prompt: {prompt}", flush=True)
        seed = data.get("seed")
        if seed is not None and (type(seed) is not int or not 0 <= seed < 2**32):
            raise ValueError("Image seed must be an integer from 0 to 4294967295.")
        image = PIPELINE(
            prompt=prompt,
            generator=torch.Generator(device="cpu").manual_seed(seed) if seed is not None else None,
            ip_adapter_image=adapter_images,
            height=768, width=512, num_inference_steps=30,
            callback_on_step_end=add_likeness_after_layout if reference else None,
            **negative_conditioning(PIPELINE, data.get("weightedNegatives", True)),
            **controls,
        ).images[0]
        output = io.BytesIO()
        image.save(output, "WEBP", quality=88)
        return {"image": "data:image/webp;base64," + base64.b64encode(output.getvalue()).decode()}


def release_image_pipeline():
    global PIPELINE
    with IMAGE_LOCK:
        PIPELINE = None
        gc.collect()
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()


def review_image(data, rendered):
    from PIL import Image
    source = Image.open(io.BytesIO(base64.b64decode(rendered["image"].split(",", 1)[1])))
    source.thumbnail((512, 768))
    jpg = io.BytesIO()
    source.convert("RGB").save(jpg, "JPEG", quality=90)
    observation = ollama_json(VISION_MODEL, [{
        "role": "user",
        "content": (
            "Describe only what is visibly drawn. Count people. Separately describe clothes actually "
            "worn on bodies, the person's posture and hand action, objects and where they are, "
            "setting, and view angle. Distinguish clothing being worn from clothing held or hanging."
            " Use empty strings when unclear. Return JSON."
        ),
        "images": [base64.b64encode(jpg.getvalue()).decode()],
    }], OBSERVATION_FORMAT, {"temperature": 0, "num_ctx": 4096, "num_predict": 220})
    return compare_image_observation(data, observation)


def compare_image_observation(data, observation):
    people = observation.get("people")
    if type(people) is not int:
        raise RuntimeError("The image reviewer could not count the characters.")
    if people != 1:
        return False, f"The reviewer saw {people} people. The scene requires one character."
    if data.get("exactPrompt"):
        criteria = {"full_prompt": data["exactPrompt"]}
    else:
        scene = data["scene"]
        action, wardrobe = art_action_and_wardrobe(scene)
        criteria = {key: scene.get(key, "") for key in ("appearance", "location", "viewpoint")}
        criteria.update(action=action, wardrobe=wardrobe)
        wearing = observation.get("wearing", "")
        if isinstance(wearing, str) and re.match(r"^\s*hangs?\b", action, re.I):
            _, remainder = art_action_and_wardrobe({"action": action, "wardrobe": wearing})
            if remainder != wearing and set(re.findall(GARMENT, remainder, re.I)) != set(re.findall(GARMENT, wearing, re.I)):
                return False, "The garment to hang is still being worn."
    return check_verdict(ollama_json(VISION_MODEL, [{
        "role": "user",
        "content": (
            "Compare the expected illustration to an independent description. Fail if the evidence "
            "omits the requested action, essential prop, or explicit wardrobe, or contradicts the "
            "setting or angle. Distinguish held or hung garments from worn garments. Treat empty fields "
            "as unknown rather than confirmation. Return passes and a short visual reason in JSON. "
            + json.dumps({"expected": criteria, "observed": observation}, ensure_ascii=False)
        ),
    }], REVIEW_FORMAT, {"temperature": 0, "num_ctx": 4096, "num_predict": 180}))


def render_checked_image(data):
    if not VISION_MODEL:
        return {**illustrate(data), "reviewed": False}

    with VERIFIED_ART_LOCK:
        reason = ""
        for attempt in range(2):
            request = data
            if attempt and type(data.get("seed")) is int:
                request = {**data, "seed": (data["seed"] + 1) % 2**32}
            rendered = illustrate(request)
            release_image_pipeline()
            passes, reason = review_image(request, rendered)
            if passes:
                return {**rendered, "reviewed": True}
        raise RuntimeError("Two illustrations missed the scene. " + reason)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            self.reply(200, {"model": MODEL})
            return
        super().do_GET()

    def do_POST(self):
        routes = {"/api/turn": narrate, "/api/image": render_checked_image}
        handler = routes.get(self.path)
        if handler is None:
            return self.reply(404, {"error": "Unknown endpoint."})
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "JSON required."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 12_000_000:
                return self.reply(413, {"error": "The request is too large or empty."})
            data = json.loads(self.rfile.read(size))
            self.reply(200, handler(data))
        except (KeyError, ValueError, TypeError) as error:
            self.reply(400, {"error": "Invalid request: " + str(error)})
        except RuntimeError as error:
            self.reply(503, {"error": str(error)})
        except Exception as error:
            self.log_error("Model failure: %s", error)
            self.reply(500, {"error": "Local generation failed. Check the terminal for details."})

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("Client disconnected before receiving the response.")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8787), partial(Handler, directory=ROOT / "dist"))
    print("Nightdraft is ready at http://127.0.0.1:8787", flush=True)
    server.serve_forever()
