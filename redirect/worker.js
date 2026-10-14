// Ancienne adresse : redirection permanente vers la nouvelle, en gardant le chemin (/e/test, #live côté navigateur…)
const NEW = "https://swim-direct.swim-direct.workers.dev";
export default {
  fetch(req) {
    const u = new URL(req.url);
    return Response.redirect(NEW + u.pathname + u.search, 301);
  },
};
