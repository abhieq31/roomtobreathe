#!/usr/bin/env python3
"""Build the zero-install web app (GitHub Pages, Vercel, any static host) into one folder.

    python scripts/build_site.py --out _site

The folder contains the dashboard (what-if, photo count, planning, gate counter), the Room to Breathe
Python engine as a wheel for Pyodide, the demo venue, and the density model, downloaded from the
models-v1 release and checked against its pinned SHA-256. Nothing is uploaded anywhere by this script.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from roomtobreathe.vision import model_store  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=ROOT / "_site")
    ap.add_argument("--model", type=Path, help="use this local dmcount_qnrf.onnx instead of downloading it")
    ap.add_argument("--no-model", action="store_true", help="skip the 86 MB model (Photo count then says so)")
    a = ap.parse_args(argv)

    out = a.out
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "src" / "roomtobreathe" / "web", out)
    (out / ".nojekyll").write_text("")  # serve files as they are
    # Mark this copy as static, so the app does not look for a control-room server that cannot exist here.
    index = out / "index.html"
    marker = '<meta charset="utf-8">\n  <meta name="rtb-static" content="1">'
    index.write_text(index.read_text(encoding="utf-8").replace('<meta charset="utf-8">', marker, 1), encoding="utf-8")
    (out / "data").mkdir()
    shutil.copy(ROOT / "src" / "roomtobreathe" / "data" / "venues" / "pandal.json", out / "data" / "pandal.json")

    py = out / "py"
    subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "-q", "-w", str(py), str(ROOT)], check=True)
    [wheel] = [p.name for p in py.glob("roomtobreathe-*.whl")]
    # The fingerprint changes whenever the engine does, so browsers never run a stale cached copy.
    digest = model_store.sha256(py / wheel)[:12]
    (py / "wheel.json").write_text(json.dumps({"wheel": wheel, "sha256": digest}) + "\n")

    if not a.no_model:
        info = model_store.MODELS["dense"]
        dest = out / "models" / info.filename
        dest.parent.mkdir()
        if a.model:
            shutil.copy(a.model, dest)
        else:
            shutil.copy(model_store.fetch("dense"), dest)
        if model_store.sha256(dest) != info.sha256:
            raise SystemExit(f"{dest} does not match the pinned checksum")
    print(f"built {out} ({wheel})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
