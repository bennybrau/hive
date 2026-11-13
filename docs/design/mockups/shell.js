// Mockup shell: theme from ?theme=, sidebar + phone top bar injected from data-page.
(function () {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get("theme") || "dark";
  const I = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    knowledge: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    review: '<path d="M4 5h16v11H8l-4 4z"/><path d="M9 10l2 2 4-4"/>',
    playbooks: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 10h6M9 14h6M9 18h3"/>',
    teams: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8 0 5 2.2 5 5"/>',
    admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;
  const page = document.body.dataset.page;
  const item = (k, label, extra = "") =>
    `<a href="#" ${page === k ? 'aria-current="page"' : ""}>${svg(k)}${label}${extra}</a>`;
  const side = `
  <aside class="side">
    <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z"/></svg></span>Hive</div>
    <nav class="nav" aria-label="Main">
      ${item("home", "Home")}
      ${item("knowledge", "Knowledge")}
      <div class="group">Curator</div>
      ${item("review", "Review", '<span class="count" aria-label="3 waiting">3</span>')}
      ${item("playbooks", "Playbooks")}
      ${item("teams", "Teams")}
      ${item("admin", "Admin")}
    </nav>
    <div class="me"><span class="avatar">J</span><span class="who"><b>Jon Arme</b><span class="small muted">Curator</span></span></div>
  </aside>`;
  const names = { home: "Home", knowledge: "Knowledge", review: "Review", admin: "Admin" };
  const top = `
  <header class="topbar">
    <span class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z"/></svg></span>
    <span class="where">${names[page] || ""}</span>
    <button class="btn quiet end" type="button" aria-expanded="false" aria-label="Menu"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>Menu</button>
  </header>`;
  const app = document.querySelector(".app");
  app.insertAdjacentHTML("afterbegin", side);
  document.body.insertAdjacentHTML("afterbegin", top);
  document.body.insertAdjacentHTML("afterbegin", '<a class="skip-link" href="#main">Skip to content</a>');
  document.querySelector("main").id = "main";
  const t = document.querySelector(".topbar button");
  t.addEventListener("click", () => { const open = document.body.classList.toggle("menu-open"); t.setAttribute("aria-expanded", String(open)); t.lastChild.textContent = open ? "Close" : "Menu"; });
})();
