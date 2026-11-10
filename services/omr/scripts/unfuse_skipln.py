"""Rewrite homr's decoder so it runs on onnxruntime-rocm.

The decoder models contain com.microsoft SkipLayerNormalization nodes whose `skip` input is
broadcast against the main input. The CPU and CUDA kernels accept that, but the ROCm kernel in
onnxruntime-rocm 1.22 insists on identical shapes, so every page failed on AMD GPUs with
"skip is expected to have same shape as input". Each node is replaced by Add (+ Add for the
optional bias) and a standard LayerNormalization, which compute the same result on every
execution provider and broadcast like the CPU kernel does.

Usage: python unfuse_skipln.py MODEL.onnx [MODEL.onnx ...]   (files are rewritten in place)
"""

from __future__ import annotations

import sys

import onnx
from onnx import helper


def unfuse(path: str) -> int:
    model = onnx.load(path)
    graph = model.graph
    consumed = {i for n in graph.node for i in n.input} | {o.name for o in graph.output}
    nodes, count = [], 0
    for n in graph.node:
        if n.op_type != "SkipLayerNormalization" or n.domain != "com.microsoft":
            nodes.append(n)
            continue
        eps = next((a.f for a in n.attribute if a.name == "epsilon"), 1e-12)
        x, skip, gamma, beta, bias = (list(n.input) + [""] * 5)[:5]
        outs = (list(n.output) + [""] * 4)[:4]
        if (outs[1] and outs[1] in consumed) or (outs[2] and outs[2] in consumed):
            raise SystemExit(
                f"{path}: {n.name} uses mean/inv_std_var outputs, which this script doesn't handle"
            )
        total = outs[3] or f"{n.name}_sum"
        if bias:
            nodes.append(helper.make_node("Add", [x, skip], [f"{n.name}_xs"], name=f"{n.name}_add_skip"))
            nodes.append(helper.make_node("Add", [f"{n.name}_xs", bias], [total], name=f"{n.name}_add_bias"))
        else:
            nodes.append(helper.make_node("Add", [x, skip], [total], name=f"{n.name}_add_skip"))
        nodes.append(
            helper.make_node(
                "LayerNormalization",
                [total, gamma] + ([beta] if beta else []),
                [outs[0]],
                name=f"{n.name}_ln",
                axis=-1,
                epsilon=eps,
            )
        )
        count += 1
    del graph.node[:]
    graph.node.extend(nodes)
    onnx.save(model, path)
    return count


if __name__ == "__main__":
    for model_path in sys.argv[1:]:
        print(f"{model_path}: replaced {unfuse(model_path)} SkipLayerNormalization nodes")
