import { parseMpp, normEvent } from "../src/extranat.js";
const tip = (sp) => sp.map(([d, t]) => `&lt;tr&gt;&lt;td class=&#039;x&#039;&gt;${d} m : &lt;/td&gt;&lt;td class=&#039;g&#039;&gt;${t}&lt;/td&gt;&lt;td&gt;(x)&lt;/td&gt;&lt;/tr&gt;`).join("");
const row = (ev, t, sp) => `<tr class="b"><th class="p" scope="row">${ev}</th><td class="f">${sp ? `<button class='tippy-button' data-tippy-content='&lt;table&gt;${tip(sp)}&lt;/table&gt;'><a class="text-blue-600">${t}</a></button>` : t}</td><td>(15 ans)</td><td>947 pts</td></tr>`;
const html = `<p>Bassin : 25 mètres</p><table>${row("200 NL", "02:22.28", [[50, "00:33.67"], [100, "01:10.08"], [150, "01:46.83"], [200, "02:22.28"]])}${row("50 NL", "00:31.00")}${row("200 NL", "02:30.00")}</table><p>Bassin : 50 mètres</p><table>${row("100 Dos", "01:12.84", [[50, "00:36.22"], [100, "01:12.84"]])}</table>`;
const r = parseMpp(html);
const ok = r[25]["200 NL"].t === 142.28 && r[25]["200 NL"].sp.length === 4 && r[25]["200 NL"].sp[1][1] === 70.08 && r[25]["50 NL"].t === 31 && r[50]["100 DOS"].t === 72.84;
console.log(JSON.stringify(r), ok ? "OK" : "ÉCHEC", normEvent("100 Papillon Dames"), normEvent("200 4 Nages Messieurs"), normEvent("4x50 Nage Libre"), normEvent("100 Bra."));
