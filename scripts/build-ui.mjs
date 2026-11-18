import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entryPoints: [path.join(root, "participant/ui/router.jsx")],
  outfile: path.join(root, "participant/ui/router.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
const layout = await build({
  entryPoints: [path.join(root, "participant/ui/layout.jsx")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  packages: "external",
  jsx: "automatic",
});
const module = { exports: {} };
vm.runInNewContext(layout.outputFiles[0].text, {
  require: createRequire(import.meta.url),
  module,
  exports: module.exports,
});
const markup = renderToStaticMarkup(
  createElement(
    StaticRouter,
    { location: "/" },
    createElement(module.exports.default),
  ),
);
const html =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark light"/><link rel="icon" href="/graphene-logo.png"/><title>Graphene · Node console</title><link rel="stylesheet" href="/styles.css"/><script type="module" src="/router.bundle.js"></script></head><body><div id="console-root">' +
  markup +
  "</div></body></html>\n";
fs.writeFileSync(path.join(root, "participant/ui/index.html"), html);
console.log("Built participant React Router frontend.");
