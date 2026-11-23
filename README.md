# Nightdraft

Nightdraft is an original solo interactive fiction app. Narration and illustration run on your computer without an account, subscription, or per-turn fee. Campaigns save in your browser. Export them from the journal to back them up or move them to another device.

## Run locally

1. Install Node.js 22.12 or later, Python 3.11 or 3.12, and [Ollama](https://ollama.com/download).
2. Start Ollama, then run `ollama pull qwen3:4b`.
3. In this repository run the commands below, then open [Nightdraft](http://127.0.0.1:8787).

```sh
npm ci
npm run build
python3 local_server.py
```

The opening illustration ships with the game. For new illustrated scenes, install the local image dependencies and run the server from that environment.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-art.txt
python local_server.py
```

On Windows, activate with `.venv\Scripts\Activate.ps1`. Use the [PyTorch installer](https://pytorch.org/get-started/locally/) to select the right CUDA build if needed. First generation downloads SDXL and IP-Adapter weights. The illustration engine supports NVIDIA CUDA and Apple Metal. Set `NIGHTDRAFT_CPU_ART=1` before launching to try CPU generation, which can be substantially slower. Turn off **Auto-illustrate** to play with saved portraits and generate art on demand.

The journal lets you edit remembered facts, update reference portraits, and import or export campaigns. Nightdraft asks the image model for one character each time, using the visible action and setting from the same saved turn. Model output, including likeness and composition, can vary.

The server binds to loopback. Keep it local. `NIGHTDRAFT_MODEL` selects an installed Ollama model with structured output support. `NIGHTDRAFT_OLLAMA` selects an alternate Ollama address.

## Verify

```sh
npm test
npm run build
python3 -m unittest discover -s tests -p "test_*.py"
npx playwright install chromium
npm run test:browser
```

GitHub Actions runs these checks on pushes and pull requests. Playwright uses deterministic model responses and exercises the UI, save and reload, rollback, mobile layout, and world creation. To verify live inference, start the local server, submit an action that changes the character's visible pose, then confirm the resulting text and art agree. Rewind and check that the prior image returns.

### Check live illustration accuracy

With the local image server running, run an acceptance case from a second terminal. Each command calls the real renderer and writes an image you can open and compare with the printed criteria.

```sh
python tests/render_character.py coat-hook coat-hook.webp
python tests/render_character.py brass-key brass-key.webp
```

Use fresh output filenames for repeated samples. An HTTP success only confirms a render completed. Check the visible action, location, clothing, props, and character likeness in the image. To see the exact text passed to SDXL, start the local server with `NIGHTDRAFT_LOG_ART_PROMPT=1`. This prints private scene descriptions to your terminal, so leave it off for ordinary play.

### Campaigns, references, and model comparisons

**Campaigns** saves worlds separately and includes **Start The Last Stop again**. The existing local campaign is added to the library on first load. **Journal → Style reference** accepts an optional image alongside the text style. **Adjust illustration → Depth guide** accepts a grayscale depth map for the current turn. The first use downloads additional model weights. Switching reference modes reloads the relevant pipeline from cache and can take time or need more memory. Default negative conditioning weights emphasize common anatomy, blur, and layout problems.

With Nightdraft running, compare narration profiles and render the same illustration with fixed seeds. Inspect the actual images for pose, camera angle, likeness, and style.

```sh
node tests/benchmark_narrator.js
python tests/render_character.py sitting sitting-31.webp --seed 31
python tests/render_character.py coat-hook coat-31.webp --seed 31
python tests/render_character.py looking-up angle-31.webp --seed 31
```

The image test also accepts `--style`, `--style-reference`, `--depth-guide`, `--prompt`, and `--unweighted-negatives` for comparison. Use the same seed and input while changing one option, then repeat with other seeds. Set `NIGHTDRAFT_BENCH_SEED` to compare narrator profiles at another seed.

### Review model output

Nightdraft checks each story draft against the player entry and current state using a second local Ollama call. If the reviewer identifies a continuity error, Nightdraft retries once and only saves a result that passes. This can make turns take longer. Set `NIGHTDRAFT_STORY_REVIEW=0` for an unreviewed baseline comparison.

To check dynamic illustrations, install a local vision model and restart the server with the reviewer enabled:

```sh
ollama pull gemma3:4b
NIGHTDRAFT_VISION_MODEL=gemma3:4b HF_HUB_DISABLE_IMPLICIT_TOKEN=1 python local_server.py
```

Image review checks the visible character, action, and essential props. When the first image misses, the app tries one more sample. If both miss, the turn keeps its prior illustration or reference and shows the reason. The vision model shares memory with SDXL, so Nightdraft releases SDXL between a render and review. This makes reviewed renders slower. A model verdict is an approximation and can itself be wrong. Leave the vision setting unset to keep using unreviewed local renders.
