/* Swim Direct · notifications (page fermée). © Mat-et-Flo */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Swim Direct", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Swim Direct", { body: d.body || "", icon: "/apple-touch-icon.png", badge: "/favicon.png", tag: "sd-" + (d.key || d.title || ""), data: { url: d.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => { const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).pathname === new URL(url, self.location.origin).pathname) { await c.focus(); try { c.navigate(url); } catch (_) {} return; } }
    await self.clients.openWindow(url); })());
});
