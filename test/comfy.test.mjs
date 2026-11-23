// ComfyUI backend: graph shape and the submit -> poll -> fetch loop against a fake server.
import http from "node:http";
import assert from "node:assert/strict";
import { buildGraph, renderWithComfy } from "../src/comfy.ts";

const base = { model: "m.safetensors", prompt: "a loon", width: 1024, height: 768 };
for (const kind of ["zimage", "sdxl"]) {
  const g = buildGraph({ ...base, kind, negative: "blur" });
  assert.ok(Object.values(g).some((n) => n.class_type === "PreviewImage"), kind);
  const texts = Object.values(g).filter((n) => n.class_type === "CLIPTextEncode").map((n) => n.inputs.text);
  assert.deepEqual(texts.sort(), ["a loon", "blur"].sort());
}

// Image-to-image encodes the source instead of a blank latent, and keeps part of it.
for (const kind of ["zimage", "sdxl"]) {
  const g = buildGraph({ ...base, kind, sourceName: "agentspine/source.png", denoise: 0.35 });
  const nodes = Object.values(g);
  assert.ok(nodes.some((n) => n.class_type === "LoadImage" && n.inputs.image === "agentspine/source.png"), kind);
  assert.ok(nodes.some((n) => n.class_type === "VAEEncode"), kind);
  assert.ok(!nodes.some((n) => n.class_type.startsWith("Empty")), kind);
  assert.equal(nodes.find((n) => n.class_type === "KSampler").inputs.denoise, 0.35);
}

let polls = 0;
const png = Buffer.from("fakepng");
const srv = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/prompt") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      assert.ok(JSON.parse(b).prompt["1"]);
      res.end(JSON.stringify({ prompt_id: "abc" }));
    });
  } else if (req.url === "/history/abc") {
    res.end(JSON.stringify(++polls < 3 ? {} : { abc: { status: { status_str: "success" }, outputs: { 10: { images: [{ filename: "x.png", subfolder: "", type: "output" }] } } } }));
  } else if (req.url.startsWith("/view?")) {
    res.end(png);
  } else { res.statusCode = 404; res.end("{}"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}`;
const out = await renderWithComfy({ ...base, kind: "zimage", baseUrl: url, pollMs: 10 });
assert.equal(out.toString(), "fakepng");
assert.equal(polls, 3);
srv.close();
console.log("comfy ok");
