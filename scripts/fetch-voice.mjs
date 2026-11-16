// Downloads the open-source Piper voice at build time so the 60 MB model stays out of git.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const NAME = "vits-piper-en_US-lessac-medium";
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${NAME}.tar.bz2`;

if (existsSync(`models/${NAME}/tokens.txt`)) {
  console.log("voice model already present");
} else {
  mkdirSync("models", { recursive: true });
  const r = await fetch(URL);
  if (!r.ok) throw new Error("voice model download failed: " + r.status);
  writeFileSync("models/voice.tar.bz2", Buffer.from(await r.arrayBuffer()));
  execSync("tar xjf voice.tar.bz2", { cwd: "models", stdio: "inherit" });
  rmSync("models/voice.tar.bz2");
  console.log("voice model downloaded");
}
