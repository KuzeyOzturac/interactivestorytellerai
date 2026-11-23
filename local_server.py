"""Serve Nightdraft and run its two model adapters on the local computer."""
import base64
import io
import json
import os
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


def narrate(data):
    sampling = {
        "baseline": {"temperature": 0.75},
        "qwen": {"temperature": 0.7, "top_p": 0.8, "top_k": 20},
        "steady": {"temperature": 0.3, "top_p": 0.8, "top_k": 20},
    }.get(data.get("sampling"), {"temperature": 0.75})
    if type(data.get("seed")) is int:
        sampling["seed"] = data["seed"]
    body = json.dumps({
        "model": MODEL, "stream": False, "think": False, "keep_alive": 0,
        "format": data["format"], "messages": data["messages"],
        "options": {"num_ctx": 8192, "num_predict": 2300, **sampling},
    }).encode()
    request = Request(f"{OLLAMA}/api/chat", body, {"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=300) as response:
            result = json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Ollama could not use {MODEL}. Check that the model is installed.") from error
    except URLError as error:
        raise RuntimeError("Start Ollama on this computer, then try again.") from error
    try:
        return json.loads(result["message"]["content"])
    except (KeyError, json.JSONDecodeError) as error:
        raise RuntimeError("The local model returned an incomplete turn. Try again.") from error


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

    wardrobe = scene.get("wardrobe", "")
    if wardrobe.strip().lower().rstrip(".") in {"undressed adult", "unclothed adult", "naked adult"}:
        wardrobe = "Naked"
    add(wardrobe)
    for field in ("action", "location"):
        add(scene.get(field, ""))

    add({
        "low": "low-angle view",
        "high": "high-angle view",
        "eye-level": "eye-level view",
        "close": "close-up view",
        "side": "profile view",
    }.get(scene.get("viewpoint"), ""))
    add(scene.get("style", ""))
    add(scene.get("appearance", ""))
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
            source = Image.open(ROOT / "public" / reference).crop((175, 85, 620, 530))
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


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            self.reply(200, {"model": MODEL})
            return
        super().do_GET()

    def do_POST(self):
        routes = {"/api/turn": narrate, "/api/image": illustrate}
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
