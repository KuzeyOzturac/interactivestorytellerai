"""Render a real acceptance-test image using a running local Nightdraft server."""
import argparse
import base64
import json
from pathlib import Path
from urllib.request import Request, urlopen

CASES = {
    "coat-hook": {
        "action": "Reaches up to hang a wet coat on a wall hook",
        "location": "Inside an apartment entryway",
        "wardrobe": "Wearing a burgundy sweater",
        "details": "Wet coat held by one hand",
    },
    "brass-key": {
        "action": "Head tilted down, pinching a small brass door key between thumb and forefinger",
        "location": "Inside the apartment hallway",
        "wardrobe": "Naked adult",
        "details": "Damp dark bob, dim hallway light",
    },
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=CASES)
    parser.add_argument("output", type=Path)
    parser.add_argument("--seed", type=int, default=31)
    args = parser.parse_args()
    scene = {**CASES[args.case], "appearance": "Adult woman with olive skin and a short dark bob"}
    body = json.dumps({"scene": scene, "reference": "mara.webp", "seed": args.seed}).encode()
    request = Request("http://127.0.0.1:8787/api/image", body, {"Content-Type": "application/json"})
    with urlopen(request, timeout=900) as response:
        image = json.load(response)["image"].removeprefix("data:image/webp;base64,")
    with args.output.open("xb") as output:
        output.write(base64.b64decode(image, validate=True))
    print(f"Saved {args.output} with seed {args.seed}. Inspect the image against these criteria:")
    for field in ("action", "location", "wardrobe", "details"):
        print(f"  {scene[field]}")


if __name__ == "__main__":
    main()
