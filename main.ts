// SLAGLINE — hand-in program for make.fun (threejs-fps-02).
// Copies the static game and its screenshots into the output directory and
// writes the dossier exactly as the kit library builds it, so the grader's
// rebuild matches byte for byte. Runs on Node 22, standard library only.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-threejs.ts";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
if (outDir === repoRoot || outDir === "/") {
  throw new Error("slagline: refusing to use the repository root (or /) as the output directory");
}

// Start from a clean output tree so two runs always produce identical bytes.
// Clean the contents only, never the directory itself: the grader's /output
// is a mount point, and removing it fails with EBUSY.
mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(outDir)) {
  rmSync(join(outDir, entry), { recursive: true, force: true });
}

cpSync(join(repoRoot, "game"), join(outDir, "game"), { recursive: true });
cpSync(join(repoRoot, "screenshots"), join(outDir, "screenshots"), {
  recursive: true,
});

// The dossier is built from the copied tree, never from the working repo.
const dossier = buildDossier(outDir, { text_max_bytes: 163840 });
const bytes =
  typeof dossier === "string"
    ? Buffer.from(dossier, "utf8")
    : dossier instanceof Uint8Array
      ? Buffer.from(dossier)
      : Buffer.from(JSON.stringify(dossier), "utf8");
writeFileSync(join(outDir, "dossier.json"), bytes);

console.log(`slagline: wrote game/, screenshots/ and dossier.json (${bytes.length} bytes) to ${outDir}`);
