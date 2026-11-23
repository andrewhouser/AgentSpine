// generate_image picks MFLUX for "draft" and ComfyUI for "best" when both are configured.
import assert from "node:assert/strict";
process.env.COMFY_URL = "http://127.0.0.1:8188";
process.env.IMAGE_URL = "http://127.0.0.1:8082/v1";
const { pickBackend, generateImage } = await import("../src/tools/generate-image.ts");
assert.equal(pickBackend("draft"), "mflux");
assert.equal(pickBackend("best"), "comfy");
assert.equal(pickBackend(undefined), "comfy");
assert.equal(pickBackend("DRAFT"), "mflux");
assert.match(generateImage.argsSchema, /quality/);
assert.match(generateImage.classify({ prompt: "x", quality: "draft", size: "2000x2000" }).summary, /768x768/);
assert.match(generateImage.classify({ prompt: "x" }).summary, /1024x1024/);
console.log("image-quality ok");
