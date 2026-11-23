"""Render a real acceptance-test image using a running local Nightdraft server."""
import argparse
import base64
import json
import mimetypes
from pathlib import Path
from urllib.request import Request, urlopen

CASES = {
    "sitting": {
        "action": "Sits on the floor",
        "location": "Apartment hallway",
        "wardrobe": "Burgundy sweater",
    },
    "looking-up": {
        "action": "Stands in the doorway",
        "location": "Apartment hallway",
        "wardrobe": "Burgundy sweater",
        "viewpoint": "low",
    },
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
    parser.add_argument("--prompt", default="")
    parser.add_argument("--style", default="")
    parser.add_argument("--style-reference", type=Path)
    parser.add_argument("--depth-guide", type=Path)
    parser.add_argument("--unweighted-negatives", action="store_true")
    parser.add_argument("--no-face-reference", action="store_true")
    args = parser.parse_args()

    def image_data(path):
        if not path:
            return ""
        media = mimetypes.guess_type(path.name)[0]
        return f"data:{media};base64," + base64.b64encode(path.read_bytes()).decode()
    scene = {**CASES[args.case], "appearance": "Adult woman with olive skin and a short dark bob"}
    scene["style"] = args.style
    body = json.dumps({
        "scene": scene, "reference": "" if args.no_face_reference else "mara.webp", "seed": args.seed, "exactPrompt": args.prompt,
        "styleReference": image_data(args.style_reference), "depthGuide": image_data(args.depth_guide),
        "weightedNegatives": not args.unweighted_negatives,
    }).encode()
    request = Request("http://127.0.0.1:8787/api/image", body, {"Content-Type": "application/json"})
    with urlopen(request, timeout=900) as response:
        image = json.load(response)["image"].removeprefix("data:image/webp;base64,")
    with args.output.open("xb") as output:
        output.write(base64.b64decode(image, validate=True))
    print(f"Saved {args.output} with seed {args.seed}.")
    if args.prompt:
        print(f"Exact image prompt: {args.prompt}")
    else:
        print("Inspect the image against these criteria:")
        for field in ("action", "location", "wardrobe"):
            print(f"  {scene[field]}")


if __name__ == "__main__":
    main()
