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
// The user's words count when the model leaves quality out; subjects do not.
assert.equal(pickBackend(undefined, "Give me a quick rough draft of a red canoe"), "mflux");
assert.equal(pickBackend(undefined, "a quick sketch of a heron"), "mflux");
assert.equal(pickBackend(undefined, "a fast car on rough seas"), "comfy");
assert.equal(pickBackend("best", "draft of a canoe"), "comfy");

// An edit from a run with no conversation reaches nothing.
assert.match(await generateImage.run({ prompt: "x", source_image: "/images/a.png" }, { policy: {} }), /no conversation/);
console.log("image-quality ok");
