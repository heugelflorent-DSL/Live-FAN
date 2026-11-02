/* Construction du site : copie public/ dans dist/ et compresse la page (code illisible, plus léger).
   © Mat-et-Flo — tous droits réservés. */
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { minify } from "html-minifier-terser";
rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true });
const NOTE = "<!-- Swim Direct © Mat-et-Flo — tous droits réservés. Reproduction, copie ou réutilisation du code interdites sans autorisation écrite. -->";
for (const f of readdirSync("dist").filter((x) => x.endsWith(".html"))) {
  const src = readFileSync("dist/" + f, "utf8");
  const out = await minify(src, {
    collapseWhitespace: true, conservativeCollapse: true, removeComments: true, minifyCSS: true,
    minifyJS: { compress: { passes: 1 }, mangle: true, format: { comments: false } },
  });
  writeFileSync("dist/" + f, out.replace(/^(<!doctype html>)/i, "$1" + NOTE));
  console.log(f, Math.round(src.length / 1024) + " Ko →", Math.round(out.length / 1024) + " Ko");
}
