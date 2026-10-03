"""Baut das Laya-Modellpaket fuer Arena (src-tauri/src/laya.rs) — einmal pro Modellversion.

Schritte:
  1. Checkpoint convaiinnovations/laya (englisch) von Hugging Face laden und mit laya-ts/scripts/export_onnx.py
     nach ONNX exportieren (encoder.onnx + head.onnx, gegen PyTorch auf 1e-4 geprueft).
  2. Gewichte auf 4 Bit (MatMulNBits / GatherBlockQuantized, Block 32). INT8 (dynamisch) taugt nicht: nur 27/40
     gleiche Antworten wie fp32; INT4: 39/40 (siehe README.md).
  3. Paket schreiben: laya-en-int4.{encoder.onnx, head.onnx, tokenizer.json, rl_agent_config.json,
     ort-<version>.wasm, LICENSE.txt} und die Zeilen fuer FILES in laya.rs ausgeben (Groesse + SHA-256).

Voraussetzungen (eigene venv, ~3 GB): torch (CPU), transformers, onnx, onnxruntime, onnxscript, huggingface_hub,
dazu ein Klon von github.com/NandhaKishorM/laya (pip install -e <klon> --no-deps) und node_modules/onnxruntime-web
in Arena (exakt die Version aus package.json).

  python tools/laya/build_model.py --laya-repo D:/Dev/_downloads/laya-build/laya --work D:/Dev/_downloads/laya-build
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

ARENA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PREFIX = "laya-en-int4"

# das npm-Paket von onnxruntime-web bringt keine LICENSE-Datei mit
ORT_LICENSE = """MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export(laya_repo, out):
    if os.path.exists(os.path.join(out, "encoder.onnx")):
        print("ONNX-Export vorhanden:", out)
        return
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", HF_HUB_DISABLE_SYMLINKS_WARNING="1")
    script = os.path.join(laya_repo, "laya-ts", "scripts", "export_onnx.py")
    subprocess.check_call([sys.executable, script, "--repo", "convaiinnovations/laya", "--out-dir", out], env=env)


def quantize_int4(src, dst):
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

    os.makedirs(dst, exist_ok=True)
    for name in ("encoder.onnx", "head.onnx"):
        model = onnx.load(os.path.join(src, name))
        cfg = DefaultWeightOnlyQuantConfig(
            block_size=32, is_symmetric=True, accuracy_level=4,
            op_types_to_quantize=("MatMul", "Gather"), quant_axes=(("MatMul", 0), ("Gather", 1)),
        )
        q = MatMulNBitsQuantizer(model, algo_config=cfg)
        q.process()
        onnx.save_model(q.model.model, os.path.join(dst, name), save_as_external_data=False)
    for name in ("tokenizer.json", "rl_agent_config.json"):
        shutil.copy(os.path.join(src, name), dst)


def package(laya_repo, int4, pkg):
    ort_dir = os.path.join(ARENA, "node_modules", "onnxruntime-web")
    ort_version = json.load(open(os.path.join(ort_dir, "package.json"), encoding="utf-8"))["version"]
    os.makedirs(pkg, exist_ok=True)
    files = [
        ("rl_agent_config.json", os.path.join(int4, "rl_agent_config.json")),
        ("tokenizer.json", os.path.join(int4, "tokenizer.json")),
        ("LICENSE.txt", None),
        (f"ort-{ort_version}.wasm", os.path.join(ort_dir, "dist", "ort-wasm-simd-threaded.wasm")),
        ("head.onnx", os.path.join(int4, "head.onnx")),
        ("encoder.onnx", os.path.join(int4, "encoder.onnx")),
    ]
    local = {"LICENSE.txt": "LICENSE.txt", f"ort-{ort_version}.wasm": "ort.wasm"}
    rows = []
    for name, src in files:
        dst = os.path.join(pkg, f"{PREFIX}.{name}")
        if src:
            shutil.copy(src, dst)
        else:
            with open(dst, "w", encoding="utf-8") as f:
                f.write("Laya (convaiinnovations/laya, Apache-2.0) - ONNX-Export (laya-ts/scripts/export_onnx.py), "
                        "Gewichte 4-Bit (MatMulNBits/GatherBlockQuantized, block 32).\n")
                f.write(f"ONNX Runtime Web {ort_version} (MIT) - ort-wasm-simd-threaded.wasm\n\n")
                f.write(open(os.path.join(laya_repo, "LICENSE"), encoding="utf-8").read())
                f.write("\n-----\n")
                f.write(ORT_LICENSE)
        rows.append((f"{PREFIX}.{name}", local.get(name, name), os.path.getsize(dst), sha256(dst)))
    rev = subprocess.check_output(["git", "-C", laya_repo, "rev-parse", "--short", "HEAD"], text=True).strip()
    print(f'\n// laya.rs\nconst PACKAGE: &str = "{PREFIX}@{rev}+ort-{ort_version}";')
    for asset, name, size, digest in rows:
        print(f'    ("{asset}", "{name}", {size:_}, "{digest}"),')
    print(f"\nPaket: {pkg} ({sum(r[2] for r in rows) // 1_000_000} MB)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--laya-repo", required=True, help="Klon von github.com/NandhaKishorM/laya")
    p.add_argument("--work", required=True, help="Arbeitsordner (braucht ~4 GB)")
    a = p.parse_args()
    fp32 = os.path.join(a.work, "model-en")
    int4 = os.path.join(a.work, "model-en-int4")
    export(a.laya_repo, fp32)
    quantize_int4(fp32, int4)
    package(a.laya_repo, int4, os.path.join(a.work, "pkg"))


if __name__ == "__main__":
    main()
