import fs from "fs"; import { createRequire } from "module";
const require = createRequire(import.meta.url); const { JSDOM } = require("jsdom"); const fx = require("./fixture.cjs");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const d = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://x.test/", beforeParse(w) { w.scrollTo = () => {}; w.fetch = async (u) => ({ ok: true, status: 200, json: async () => u === "/api/state" ? { published: true, config: fx.config, data: fx.data, now: Date.now() } : {} }); } });
const w = d.window, q = (s) => w.document.querySelector(s), errs = []; w.addEventListener("error", (e) => errs.push(e.message));
const t = () => new Promise((r) => setTimeout(r, 120));
await t(); q("[data-view=part]").click(); await t();
q("#pub-body [data-open]").click(); await t();
q("#pub-body [data-fav]").click(); await t(); // suit le club
q("#pub-body [data-swimmer]").click(); await t();
console.log("detail btn:", q("#detail [data-fav]")?.textContent);
q("[data-view=home]").click(); await t();
console.log("home:", q("#pub-body .myswim")?.textContent.replace(/\s+/g, " ").slice(0, 300));
q("[data-view=res]").click(); await t(); q("#pub-body [data-open]")?.click(); await t();
console.log("fav rows in results:", w.document.querySelectorAll("#pub-body .rk-row.fav").length, "stored:", w.localStorage.getItem("sd-fav"), "errors", errs);
process.exit(0);
