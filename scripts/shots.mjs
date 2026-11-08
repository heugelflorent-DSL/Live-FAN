import { chromium, devices } from "playwright"; import fs from "fs";
fs.mkdirSync("shots", { recursive: true });
const B = "https://swim-direct.swim-direct.workers.dev";
const sizes = { "ipad-portrait": { ...devices["iPad (gen 7)"] }, "ipad-paysage": { ...devices["iPad (gen 7) landscape"] }, "ipadpro-paysage": { ...devices["iPad Pro 11 landscape"] } };
const pages = [["accueil", "/"], ["direct", "/e/interclubs-lge-2026#live"], ["programme", "/e/interclubs-lge-2026#prog"], ["resultats", "/e/interclubs-lge-2026#res"], ["classement", "/e/interclubs-lge-2026#rank"], ["nageurs", "/e/interclubs-lge-2026#part"], ["alsace-direct", "/e/interclubs-alsace-2026#live"]];
const b = await chromium.launch();
for (const [sz, dev] of Object.entries(sizes)) {
  const c = await b.newContext({ ...dev }); const p = await c.newPage();
  for (const [n, u] of pages) {
    try { await p.goto(B + u, { waitUntil: "networkidle", timeout: 30000 }); await p.waitForTimeout(2500);
      const over = await p.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 2 && getComputedStyle(e).position !== "fixed"; }).slice(0, 8).map(e => (e.className || e.tagName) + " " + Math.round(e.getBoundingClientRect().right)); });
      fs.appendFileSync("shots/overflow.txt", `${sz} ${n}: ${JSON.stringify(over)}\n`);
      await p.screenshot({ path: `shots/${sz}-${n}.png` });
      if (n === "resultats" || n === "direct") { await p.evaluate(() => { const el = document.querySelector("[data-sp]"); el && el.click(); }); await p.waitForTimeout(800); await p.screenshot({ path: `shots/${sz}-${n}-ouvert.png`, fullPage: false }); }
    } catch (e) { fs.appendFileSync("shots/overflow.txt", `${sz} ${n}: ERR ${e.message}\n`); }
  }
  await c.close();
}
await b.close();
