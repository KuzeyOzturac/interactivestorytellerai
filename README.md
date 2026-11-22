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
