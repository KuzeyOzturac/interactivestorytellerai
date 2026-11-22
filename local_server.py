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
IMAGE_LOCK = threading.Lock()


def narrate(data):
    body = json.dumps({
        "model": MODEL, "stream": False, "think": False, "keep_alive": 0,
        "format": data["format"], "messages": data["messages"],
        "options": {"num_ctx": 8192, "num_predict": 2300, "temperature": 0.75},
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


def scene_prompt(scene, tokenizers):
    # Leave room for separators and special tokens in both SDXL encoders.
    prefix = "Solo character"
    pieces = [prefix]
    for field, budget in (("action", 26), ("location", 14), ("details", 12), ("appearance", 12)):
        words = scene[field].split()
        while words and not all(
            len(tokenizer(" ".join(words), add_special_tokens=False, verbose=False).input_ids) <= budget
            and len(tokenizer(", ".join([*pieces, " ".join(words)]), verbose=False).input_ids) <= tokenizer.model_max_length
            for tokenizer in tokenizers
        ):
            words.pop()
        if words:
            pieces.append(" ".join(words).rstrip(",."))
    style = ", ".join([*pieces, "medium-wide action shot, painterly illustration"])
    if all(len(tokenizer(style, verbose=False).input_ids) <= tokenizer.model_max_length for tokenizer in tokenizers):
        return style
    return ", ".join(pieces)


def illustrate(data):
    global PIPELINE
    try:
        import torch
        from diffusers import StableDiffusionXLPipeline
        from PIL import Image, ImageOps
    except ImportError as error:
        raise RuntimeError("Install the local image dependencies listed in the README to render a scene.") from error

    with IMAGE_LOCK, torch.inference_mode():
        if PIPELINE is None:
            cuda = torch.cuda.is_available()
            if not cuda and not torch.backends.mps.is_available() and os.environ.get("NIGHTDRAFT_CPU_ART") != "1":
                raise RuntimeError("No CUDA or Apple Metal device detected. Enable CPU art in the README if desired.")
            pipeline = StableDiffusionXLPipeline.from_pretrained(
                "stabilityai/stable-diffusion-xl-base-1.0",
                torch_dtype=torch.float16 if cuda or torch.backends.mps.is_available() else torch.float32,
                use_safetensors=True,
                **({"variant": "fp16"} if cuda or torch.backends.mps.is_available() else {}),
            )
            pipeline.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models",
                                     weight_name="ip-adapter-plus-face_sdxl_vit-h.safetensors",
                                     image_encoder_folder="models/image_encoder")
            if cuda:
                pipeline.enable_model_cpu_offload()
            elif torch.backends.mps.is_available():
                pipeline.to("mps")
            PIPELINE = pipeline
        reference = data.get("reference", "")
        if reference.startswith(("data:image/png;base64,", "data:image/webp;base64,", "data:image/jpeg;base64,")):
            source = Image.open(io.BytesIO(base64.b64decode(reference.split(",", 1)[1], validate=True)))
        elif reference == "mara.webp":
            source = Image.open(ROOT / "public" / reference)
            source = source.crop((175, 85, 620, 530))
        else:
            source = Image.new("RGB", (224, 224))
        PIPELINE.set_ip_adapter_scale(0.12 if reference else 0.0)

        def add_likeness_after_layout(pipe, step, _timestep, callback_kwargs):
            if step == 11:
                pipe.set_ip_adapter_scale(0.35)
            return callback_kwargs

        image = PIPELINE(
            prompt=scene_prompt(data["scene"], (PIPELINE.tokenizer, PIPELINE.tokenizer_2)),
            negative_prompt="multiple people, crowd, duplicate person, disembodied hands, text, watermark",
            ip_adapter_image=ImageOps.fit(source.convert("RGB"), (224, 224)),
            height=768, width=512, num_inference_steps=30,
            callback_on_step_end=add_likeness_after_layout if reference else None,
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
            if not 0 < size <= 8_000_000:
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
