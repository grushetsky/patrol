/* Patrol service prototype. Throwaway UI; state lives in memory only. */
(() => {
  "use strict";

  const RECIPIENTS = {
    google: { name: "Google", glyph: "G" },
    bing: { name: "Bing", glyph: "b" },
    yandex: { name: "Yandex", glyph: "Y" },
  };

  const DECISIONS = {
    dismiss: { label: "Not a copy", message: "Candidate dismissed." },
    wrong: { label: "Wrong title", message: "Marked as the wrong work." },
    authorized: { label: "Authorized here", message: "Host allowlisted for this title." },
    dead: { label: "Page dead", message: "Candidate marked as a dead page." },
  };

  const SCAN_POOL = [
    { url: "https://mirror-vault.example/neon-pursuit", engine: "bing", titleId: "t3", rank: 2, score: 92 },
    { url: "https://ok-stream.example/the-long-chase-full", engine: "yandex", titleId: "t2", rank: 4, score: 86 },
    { url: "https://cinema-free.example/midnight-precinct", engine: "google", titleId: "t1", rank: 3, score: 94 },
    { url: "https://archive-copy.example/cold-case-41", engine: "bing", titleId: "t4", rank: 7, score: 81 },
    { url: "https://telly.example/neon-pursuit-hd", engine: "google", titleId: "t3", rank: 5, score: 89 },
    { url: "https://vidnest.example/midnight-precinct-2024", engine: "yandex", titleId: "t1", rank: 2, score: 96 },
  ];

  const ACTIVITY_ICONS = {
    siren: "i-siren",
    radar: "i-radar",
    check: "i-check",
    file: "i-file",
    lock: "i-lock",
    send: "i-send",
    bolt: "i-bolt",
    x: "i-x",
  };

  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: "i-gauge" },
    { id: "review", label: "Review", icon: "i-radar" },
    { id: "violations", label: "Violations", icon: "i-shield" },
    { id: "notices", label: "Notices", icon: "i-file" },
    { id: "titles", label: "Titles", icon: "i-film" },
  ];

  const state = seedState();
  const selected = new Set();

  const view = document.getElementById("view");
  const tabs = document.getElementById("tabs");
  const scanBtn = document.getElementById("scan-btn");
  const scanLine = document.getElementById("scan-line");
  const sirenBtn = document.getElementById("siren-toggle");
  const toasts = document.getElementById("toasts");
  const modal = document.getElementById("modal");
  const modalBody = document.getElementById("modal-body");
  const modalTitle = document.getElementById("modal-title");

  function seedState() {
    return {
      scanning: false,
      cartRecipient: "google",
      nextNotice: 1044,
      engines: {
        google: { last: "2m" },
        bing: { last: "9m" },
        yandex: { last: "14m" },
      },
      titles: [
        {
          id: "t1",
          name: "Midnight Precinct",
          original: "Midnight Precinct",
          year: 2024,
          group: "Feature slate",
          variants: 3,
          allowlist: ["official.example"],
          paused: false,
          glow: "rgba(61, 139, 255, 0.5)",
        },
        {
          id: "t2",
          name: "The Long Chase",
          original: "The Long Chase",
          year: 2023,
          group: "Feature slate",
          variants: 2,
          allowlist: [],
          paused: false,
          glow: "rgba(255, 61, 94, 0.42)",
        },
        {
          id: "t3",
          name: "Neon Pursuit",
          original: "Neon Pursuit",
          year: 2025,
          group: "Winter slate",
          variants: 3,
          allowlist: ["festival.example"],
          paused: false,
          glow: "rgba(139, 123, 255, 0.5)",
        },
        {
          id: "t4",
          name: "Cold Case 41",
          original: "Cold Case 41",
          year: 2021,
          group: "Archive",
          variants: 2,
          allowlist: [],
          paused: true,
          glow: "rgba(255, 176, 32, 0.4)",
        },
      ],
      candidates: [
        {
          id: "c1",
          url: "https://stream-hub.example/watch/midnight-precinct-2024",
          engine: "google",
          titleId: "t1",
          rank: 1,
          score: 97,
          allowlisted: false,
        },
        {
          id: "c2",
          url: "https://magnetbay.example/torrent/8841",
          engine: "yandex",
          titleId: "t3",
          rank: 3,
          score: 88,
          allowlisted: false,
        },
        {
          id: "c3",
          url: "https://official.example/premiere/midnight-precinct",
          engine: "bing",
          titleId: "t1",
          rank: 1,
          score: 100,
          allowlisted: true,
        },
        {
          id: "c4",
          url: "https://vk-video.example/video-2291",
          engine: "google",
          titleId: "t2",
          rank: 6,
          score: 74,
          allowlisted: false,
        },
      ],
      violations: [
        {
          id: "v1",
          titleId: "t2",
          host: "film-mirror.example",
          url: "https://film-mirror.example/the-long-chase",
          evidence: {
            id: "EV-2381",
            at: "02:58 UTC",
            hash: "9f3c1d0a77b4",
            chain: ["301 → film-mirror.example", "302 → cdn.film-mirror.example", "200 → /the-long-chase"],
          },
          state: "open",
          noticeId: "N-1043",
        },
        {
          id: "v2",
          titleId: "t3",
          host: "neon-stream.example",
          url: "https://neon-stream.example/pursuit",
          evidence: {
            id: "EV-2379",
            at: "02:44 UTC",
            hash: "b81e4cc902af",
            chain: ["200 → /pursuit"],
          },
          state: "open",
          noticeId: "N-1043",
        },
        {
          id: "v3",
          titleId: "t1",
          host: "rapid-video.example",
          url: "https://rapid-video.example/midnight-precinct-2024",
          evidence: {
            id: "EV-2374",
            at: "01:19 UTC",
            hash: "4a7d90fe12c8",
            chain: ["302 → /embed/2291", "200 → /watch/2291"],
          },
          state: "open",
          noticeId: null,
        },
        {
          id: "v4",
          titleId: "t4",
          host: "cold-archive.example",
          url: "https://cold-archive.example/cold-case-41",
          evidence: {
            id: "EV-2312",
            at: "Yesterday, 20:51 UTC",
            hash: "e2a44b7d1c03",
            chain: ["301 → /cc41", "200 → /cc41/player"],
          },
          state: "removed",
          noticeId: "N-1042",
        },
      ],
      notices: [
        {
          id: "N-1043",
          recipient: "google",
          state: "draft",
          citations: ["v1", "v2"],
          createdAt: "03:02",
          signatory: "Mara Voss",
          submission: null,
        },
        {
          id: "N-1042",
          recipient: "bing",
          state: "approved",
          citations: ["v4"],
          createdAt: "Yesterday, 21:08",
          signatory: "Mara Voss",
          submission: { state: "acknowledged", at: "Yesterday, 21:12" },
        },
      ],
      activity: [
        { icon: "check", tone: "green", text: "Bing acknowledged notice N-1042.", time: "2m" },
        { icon: "radar", tone: "blue", text: "Yandex scan finished · 2 candidates.", time: "14m" },
        { icon: "siren", tone: "red", text: "Violation logged · The Long Chase.", time: "41m" },
        { icon: "lock", tone: "green", text: "Allowlist match · official.example.", time: "1h" },
        { icon: "file", tone: "amber", text: "Notice N-1043 drafted for Google.", time: "1h" },
      ],
    };
  }

  /* Helpers. */
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#${name}" /></svg>`;
  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const timeNow = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const uid = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7)}`;
  const titleOf = (id) => state.titles.find((title) => title.id === id);
  const engineOf = (id) => RECIPIENTS[id] || RECIPIENTS.google;
  const scoreLevel = (score) => (score >= 90 ? "high" : score >= 78 ? "mid" : "low");
  const openViolations = () => state.violations.filter((violation) => violation.state === "open");
  const draftNotices = () => state.notices.filter((notice) => notice.state === "draft");

  function currentRoute() {
    const route = location.hash.replace(/^#\/?/, "");
    return TABS.some((tab) => tab.id === route) ? route : "dashboard";
  }

  function render() {
    const route = currentRoute();
    const renderers = {
      dashboard: renderDashboard,
      review: renderReview,
      violations: renderViolations,
      notices: renderNotices,
      titles: renderTitles,
    };
    view.innerHTML = renderers[route]();
    updateChrome();
  }

  function updateChrome() {
    const route = currentRoute();
    const counts = {
      review: state.candidates.length,
      violations: openViolations().length,
      notices: draftNotices().length,
    };
    tabs.innerHTML = TABS.map((tab) => {
      const count = counts[tab.id] || 0;
      const current = tab.id === route ? ' aria-current="page"' : "";
      const badge = count ? `<span class="count" data-tone="${tab.id === "notices" ? "amber" : "red"}">${count}</span>` : "";
      return `<a class="tab" href="#/${tab.id}"${current}>${icon(tab.icon, "icon--sm")}${tab.label}${badge}</a>`;
    }).join("");

    if (state.scanning) {
      scanBtn.disabled = true;
      scanBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Scanning…</span>`;
    } else {
      scanBtn.disabled = false;
      scanBtn.innerHTML = `${icon("i-radar", "icon--sm")}<span>Run scans</span>`;
    }
  }

  function toast(text, tone = "blue", iconName = "i-bolt") {
    const node = document.createElement("div");
    node.className = "toast";
    node.dataset.tone = tone;
    node.setAttribute("role", "status");
    node.innerHTML = `${icon(iconName)}<span>${esc(text)}</span>`;
    toasts.appendChild(node);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      node.style.transition = "opacity .25s, transform .25s";
      setTimeout(() => node.remove(), 260);
    }, 3400);
  }

  /* Screens. */
  function renderDashboard() {
    const pending = state.candidates.length;
    const open = openViolations().length;
    const served = state.notices.filter((notice) => notice.submission && notice.submission.state === "acknowledged").length;
    const pages = state.titles.length;

    const blips = [
      { cls: "blip--red", top: "24%", left: "63%", delay: "0s" },
      { cls: "blip--amber", top: "58%", left: "31%", delay: "0.9s" },
      { cls: "blip--red", top: "68%", left: "70%", delay: "1.6s" },
      { cls: "blip--blue", top: "38%", left: "22%", delay: "2.2s" },
      { cls: "blip--amber", top: "20%", left: "38%", delay: "2.8s" },
    ];

    const engines = Object.entries(RECIPIENTS)
      .map(
        ([id, meta]) => `
        <div class="engine-row">
          <span class="engine-badge" data-engine="${id}">${meta.glyph}</span>
          <span class="name">${meta.name}</span>
          <span class="status" aria-hidden="true"></span>
          <span class="when">${esc(state.engines[id].last)}</span>
        </div>`,
      )
      .join("");

    const activity = state.activity
      .slice(0, 6)
      .map(
        (item) => `
        <div class="act" data-tone="${item.tone}">
          <span class="act-icon">${icon(ACTIVITY_ICONS[item.icon] || "i-bolt", "icon--sm")}</span>
          <span class="act-text">${esc(item.text)}</span>
          <span class="act-time">${esc(item.time)}</span>
        </div>`,
      )
      .join("");

    const latest = state.candidates
      .slice(0, 3)
      .map((candidate) => {
        const title = titleOf(candidate.titleId);
        return `
        <a class="mini-item" href="#/review">
          <span class="mini-thumb">${icon("i-film", "icon--sm")}</span>
          <span class="mini-main">
            <span class="mini-title">${esc(title ? title.name : "Unknown title")}</span>
            <span class="mini-url">${esc(candidate.url)}</span>
          </span>
          <span class="mini-score">${candidate.score}%</span>
        </a>`;
      })
      .join("");

    const health = pending === 0 ? "Queue clear" : `${pending} pending`;
    const headline =
      open === 0
        ? `All quiet. <span class="accent">For now.</span>`
        : `${open} open ${open === 1 ? "case" : "cases"}. <span class="siren-text">Keep moving.</span>`;

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${timeNow()} · all engines up · ${health}</p>
            <h1 class="page-title">${headline}</h1>
          </div>
          <p class="head-note">One rights holder. Every engine. Evidence sealed at capture.</p>
        </header>

        <div class="stats">
          <div class="stat" data-tone="red">
            <span class="stat-icon">${icon("i-shield")}</span>
            <div class="stat-num">${open}</div>
            <div class="stat-label">Open violations</div>
          </div>
          <div class="stat" data-tone="amber">
            <span class="stat-icon">${icon("i-radar")}</span>
            <div class="stat-num">${pending}</div>
            <div class="stat-label">Candidates to review</div>
          </div>
          <div class="stat" data-tone="blue">
            <span class="stat-icon">${icon("i-file")}</span>
            <div class="stat-num">${state.notices.length}</div>
            <div class="stat-label">Notices on file</div>
          </div>
          <div class="stat" data-tone="green">
            <span class="stat-icon">${icon("i-check")}</span>
            <div class="stat-num">${served}</div>
            <div class="stat-label">Acknowledged</div>
          </div>
        </div>

        <div class="dash-grid">
          <div class="dash-col">
            <div class="panel">
              <div class="panel-head"><span>Activity</span><a href="#/notices">Notices ${icon("i-arrow", "icon--sm")}</a></div>
              <div class="panel-body activity">${activity}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><span>Latest candidates</span><a href="#/review">Review ${icon("i-arrow", "icon--sm")}</a></div>
              <div class="panel-body">${
                latest ||
                `<p class="muted" style="padding:10px;font-size:12px">No candidates waiting.</p>`
              }</div>
            </div>
          </div>

          <div class="dash-col">
            <div class="radar-card">
              <div class="panel-head"><span>Live sweep</span><span class="chip chip--live"><span class="dot"></span>Watching</span></div>
              <div class="radar-wrap">
                <div class="radar">
                  <div class="radar-sweep"></div>
                  ${blips
                    .map(
                      (blip) =>
                        `<span class="blip ${blip.cls}" style="top:${blip.top};left:${blip.left};animation-delay:${blip.delay}"></span>`,
                    )
                    .join("")}
                  <span class="radar-center">${icon("i-shield")}</span>
                </div>
              </div>
              <div class="radar-legend">
                <span style="color:var(--red)"><i></i>Violation</span>
                <span style="color:var(--amber)"><i></i>Candidate</span>
                <span style="color:var(--blue)"><i></i>Clean</span>
              </div>
              <div class="engines">${engines}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><span>Guardrails</span><span class="chip chip--muted">${pages} titles</span></div>
              <div class="panel-body" style="padding:14px 16px">
                <p class="muted" style="margin:0 0 10px;font-size:12px">Every candidate passes the allowlist before a violation can be opened.</p>
                <div class="candidate-meta">
                  <span class="chip chip--blue">${icon("i-lock", "icon--sm")}Allowlist enforced</span>
                  <span class="chip">Immutable evidence</span>
                  <span class="chip">One queue</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderReview() {
    const cards = state.candidates.map((candidate) => candidateCard(candidate)).join("");
    const empty = `
      <div class="empty">
        <span class="empty-icon">${icon("i-shield", "icon--lg")}</span>
        <h2>Queue clear.</h2>
        <p>No candidates left. Run scans across Google, Bing, and Yandex to restock the beat.</p>
        <button class="btn btn-primary" type="button" data-action="scan">${icon("i-radar", "icon--sm")}Run scans</button>
      </div>`;

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>Review queue · ${state.candidates.length} pending</p>
            <h1 class="page-title">Pick the <span class="accent">real ones.</span></h1>
          </div>
          <p class="head-note">Confirming opens a violation and seals evidence. Allowlisted hosts can never be confirmed.</p>
        </header>
        <div class="queue" id="queue">${cards || empty}</div>
      </section>`;
  }

  function candidateCard(candidate) {
    const title = titleOf(candidate.titleId);
    const engine = engineOf(candidate.engine);
    const level = scoreLevel(candidate.score);
    const locked = candidate.allowlisted;
    const actions = Object.entries(DECISIONS)
      .map(
        ([decision, meta]) => `
        <button class="btn btn-ghost btn-sm" type="button" data-action="review" data-id="${candidate.id}" data-decision="${decision}">
          ${meta.label}
        </button>`,
      )
      .join("");

    return `
      <article class="candidate" data-id="${candidate.id}">
        <span class="candidate-thumb">${icon("i-film", "icon--sm")}</span>
        <div class="candidate-body">
          <div class="candidate-top">
            <div style="min-width:0">
              <h3 class="candidate-title">${esc(title ? title.name : "Unknown title")} <span>· ${title ? title.year : "—"}</span></h3>
              <span class="candidate-url">${esc(candidate.url)}</span>
            </div>
          </div>
          <div class="candidate-meta">
            <span class="chip chip--blue">${icon("i-globe", "icon--sm")}${engine.name}</span>
            <span class="chip">Rank #${candidate.rank}</span>
            <span class="chip">${esc(hostOf(candidate.url))}</span>
            ${locked ? `<span class="chip chip--locked">${icon("i-lock", "icon--sm")}Allowlisted</span>` : ""}
          </div>
          <div class="candidate-actions">
            <button class="btn btn-danger btn-sm btn-confirm" type="button" data-action="review" data-id="${candidate.id}" data-decision="confirm" ${
              locked ? 'disabled title="Allowlisted hosts cannot be confirmed"' : ""
            }>${icon("i-siren", "icon--sm")}Confirm violation</button>
            ${actions}
          </div>
        </div>
        <div class="candidate-score">
          <span class="score-num" data-level="${level}">${candidate.score}%</span>
          <span class="score-track"><span class="score-fill" style="width:${candidate.score}%"></span></span>
          <span class="score-label">Match</span>
        </div>
      </article>`;
  }

  function renderViolations() {
    const rows = state.violations
      .map((violation) => {
        const title = titleOf(violation.titleId);
        const picked = selected.has(violation.id);
        const inNotice = Boolean(violation.noticeId);
        const canPick = violation.state === "open" && !inNotice;
        return `
        <div class="violation ${violation.state === "removed" ? "is-removed" : ""} ${picked ? "is-picked" : ""}">
          <input class="check" type="checkbox" aria-label="Select ${esc(violation.host)} for a notice" data-select="${violation.id}" ${
            picked ? "checked" : ""
          } ${canPick ? "" : "disabled"} />
          <div style="min-width:0">
            <div class="v-title">${esc(title ? title.name : "Unknown title")} <span class="v-host-name muted">· ${esc(violation.host)}</span></div>
            <div class="v-host">${icon("i-link", "icon--sm")}${esc(violation.url)}</div>
          </div>
          <div class="v-evidence">
            <button class="btn-evidence" type="button" data-action="evidence" data-id="${violation.id}">${icon("i-lock", "icon--sm")}${esc(violation.evidence.id)}</button>
            <span>${esc(violation.evidence.at)}</span>
          </div>
          <div class="v-status">
            ${
              inNotice && violation.state === "open"
                ? `<span class="chip chip--amber">In notice</span>`
                : violation.state === "removed"
                  ? `<span class="chip chip--muted">Removed</span>`
                  : `<span class="chip chip--danger"><span class="dot"></span>Open</span>`
            }
          </div>
        </div>`;
      })
      .join("");

    const cart = selected.size
      ? `<div class="cart">
          <span class="cart-count"><b>${selected.size}</b> selected</span>
          <select class="select" id="recipient" aria-label="Notice recipient">
            ${Object.entries(RECIPIENTS)
              .map(
                ([id, meta]) =>
                  `<option value="${id}" ${state.cartRecipient === id ? "selected" : ""}>${meta.name}</option>`,
              )
              .join("")}
          </select>
          <button class="btn btn-primary btn-sm" type="button" data-action="draft-notice">${icon("i-file", "icon--sm")}Draft notice</button>
        </div>`
      : "";

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>Violations · ${openViolations().length} open</p>
            <h1 class="page-title">Open <span class="siren-text">cases.</span></h1>
          </div>
          <p class="head-note">Select open violations to draft a notice for one recipient. Evidence stays attached.</p>
        </header>
        ${
          rows
            ? rows
            : `<div class="empty">
                <span class="empty-icon">${icon("i-shield", "icon--lg")}</span>
                <h2>No open violations.</h2>
                <p>Confirm a candidate in the review queue to open the first case.</p>
                <a class="btn btn-primary" href="#/review">${icon("i-radar", "icon--sm")}Go to review</a>
              </div>`
        }
        ${cart}
      </section>`;
  }

  function noticeState(notice) {
    if (notice.submission && notice.submission.state === "acknowledged") return { label: "Acknowledged", cls: "chip--live" };
    if (notice.submission && notice.submission.state === "delivered") return { label: "Delivered", cls: "chip--blue" };
    if (notice.submission && notice.submission.state === "pending") return { label: "Sending", cls: "chip--amber" };
    if (notice.state === "approved") return { label: "Approved", cls: "chip--blue" };
    return { label: "Draft", cls: "chip--amber" };
  }

  function stepper(notice) {
    const delivered = notice.submission && ["delivered", "acknowledged"].includes(notice.submission.state);
    const acknowledged = notice.submission && notice.submission.state === "acknowledged";
    const approved = notice.state === "approved" || delivered || acknowledged;
    const steps = [
      { label: "Draft", done: true },
      { label: "Approved", done: approved },
      { label: "Delivered", done: delivered || acknowledged },
      { label: "Acknowledged", done: acknowledged },
    ];
    const current = notice.submission
      ? notice.submission.state === "acknowledged"
        ? -1
        : notice.submission.state === "delivered"
          ? 3
          : 2
      : approved
        ? 2
        : 0;

    return `<div class="stepper">${steps
      .map((step, index) => {
        const cls = step.done && index !== current ? "is-done" : index === current ? "is-current" : "";
        const line = index < steps.length - 1 ? `<span class="step-line ${step.done && index < current ? "is-done" : ""}"></span>` : "";
        return `<span class="step ${cls}"><span class="step-dot"></span>${step.label}</span>${line}`;
      })
      .join("")}</div>`;
  }

  function renderNotices() {
    const cards = state.notices
      .map((notice) => {
        const meta = engineOf(notice.recipient);
        const status = noticeState(notice);
        const count = notice.citations.length;
        const approved = notice.state === "approved";
        const sending = notice.submission && notice.submission.state === "pending";
        const done = notice.submission && ["delivered", "acknowledged"].includes(notice.submission.state);
        return `
        <article class="notice">
          <div class="notice-head">
            <span class="notice-glyph">${icon("i-file")}</span>
            <div class="notice-main">
              <div class="notice-id">${notice.id} · ${meta.name}</div>
              <div class="notice-sub">${count} ${count === 1 ? "violation" : "violations"} · ${esc(notice.signatory)} · drafted ${esc(notice.createdAt)}${
                notice.submission && notice.submission.at ? ` · sent ${esc(notice.submission.at)}` : ""
              }</div>
            </div>
            <span class="chip ${status.cls}">${status.label}</span>
            <div class="notice-actions">
              ${
                notice.state === "draft"
                  ? `<button class="btn btn-primary btn-sm" type="button" data-action="approve-notice" data-id="${notice.id}">${icon("i-check", "icon--sm")}Approve</button>`
                  : approved && !notice.submission
                    ? `<button class="btn btn-primary btn-sm" type="button" data-action="send-notice" data-id="${notice.id}">${icon("i-send", "icon--sm")}Send</button>`
                    : approved && sending
                      ? `<button class="btn btn-sm" type="button" disabled><span class="spinner"></span>Sending</button>`
                      : ""
              }
              <button class="btn btn-ghost btn-sm" type="button" data-action="view-notice" data-id="${notice.id}">${icon("i-eye", "icon--sm")}View</button>
            </div>
          </div>
          <div class="notice-body">
            ${stepper(notice)}
            <div class="notice-doc-cta">
              ${icon("i-globe", "icon--sm")}Recipient: ${meta.name} · ${count > 1 ? "one notice, several violations" : "one violation"}
              <button type="button" data-action="view-notice" data-id="${notice.id}">Open document</button>
            </div>
          </div>
        </article>`;
      })
      .join("");

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>Notices · ${draftNotices().length} awaiting approval</p>
            <h1 class="page-title">Signed, sealed, <span class="accent">served.</span></h1>
          </div>
          <p class="head-note">An approved notice is immutable. A change creates a new notice.</p>
        </header>
        ${cards || `<div class="empty"><span class="empty-icon">${icon("i-file", "icon--lg")}</span><h2>No notices yet.</h2><p>Select open violations to draft the first notice.</p><a class="btn btn-primary" href="#/violations">${icon("i-shield", "icon--sm")}Open violations</a></div>`}
      </section>`;
  }

  function renderTitles() {
    const cards = state.titles
      .map(
        (title) => `
        <article class="title-card ${title.paused ? "is-paused" : ""}">
          <span class="poster" style="--poster-glow:${title.glow}">${esc(title.name.charAt(0))}</span>
          <div class="title-main">
            <h3 class="title-name">${esc(title.name)}</h3>
            <div class="title-sub">${title.year} · ${esc(title.group)}</div>
            <div class="title-meta">
              <span class="chip">${title.variants} variants</span>
              <span class="chip">${title.allowlist.length ? `${title.allowlist.length} allowlisted` : "No allowlist"}</span>
              ${
                title.paused
                  ? `<span class="chip chip--muted"><span class="dot"></span>Paused</span>`
                  : `<span class="chip chip--live"><span class="dot"></span>Watching</span>`
              }
            </div>
          </div>
          <div class="title-side">
            <button class="switch" type="button" role="switch" aria-checked="${!title.paused}" aria-label="Toggle tracking for ${esc(
              title.name,
            )}" data-action="toggle-title" data-id="${title.id}"><span class="switch-thumb"></span></button>
            ${title.allowlist.length ? `<span class="chip chip--muted">${title.allowlist.length === 1 ? "1 rule" : `${title.allowlist.length} rules`}</span>` : ""}
          </div>
        </article>`,
      )
      .join("");

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>Catalogue · ${state.titles.length} tracked titles</p>
            <h1 class="page-title">On the <span class="accent">watch.</span></h1>
          </div>
          <p class="head-note">Every title lives in one group. Pausing stops new scans without losing its history.</p>
        </header>
        <div class="title-grid">${cards}</div>
      </section>`;
  }

  /* Modals. */
  function openModal(label, html) {
    modalTitle.textContent = label;
    modalBody.innerHTML = html;
    if (!modal.open) modal.showModal();
  }

  function evidenceModal(violation) {
    const title = titleOf(violation.titleId);
    const evidence = violation.evidence;
    openModal(
      `Evidence · ${evidence.id}`,
      `<dl class="evidence-grid">
        <div class="ev-row"><dt>Title</dt><dd>${esc(title ? title.name : "Unknown")}</dd></div>
        <div class="ev-row"><dt>URL</dt><dd>${esc(violation.url)}</dd></div>
        <div class="ev-row"><dt>Host</dt><dd>${esc(violation.host)}</dd></div>
        <div class="ev-row"><dt>Captured</dt><dd>${esc(evidence.at)}</dd></div>
        <div class="ev-row"><dt>SHA-256</dt><dd>${esc(evidence.hash)}</dd></div>
      </dl>
      <div class="chain">${evidence.chain.map((hop) => `<span>${esc(hop)}</span>`).join("<i>→</i>")}</div>
      <p class="muted" style="margin:16px 0 0;font-size:11.5px">Immutable record. A later capture creates new evidence and never replaces this one.</p>`,
    );
  }

  function noticeModal(notice) {
    const meta = engineOf(notice.recipient);
    const violations = notice.citations
      .map((id) => state.violations.find((violation) => violation.id === id))
      .filter(Boolean);
    const list = violations
      .map((violation) => {
        const title = titleOf(violation.titleId);
        return `<li>${esc(title ? title.name : "Unknown title")} — ${esc(violation.host)}<br /><span class="doc-cite">${esc(violation.url)} · evidence ${esc(
          violation.evidence.id,
        )} at ${esc(violation.evidence.at)}</span></li>`;
      })
      .join("");
    const stamp = notice.submission ? "SERVED" : notice.state === "approved" ? "APPROVED" : "DRAFT";
    openModal(
      `Notice · ${notice.id}`,
      `<article class="doc">
        <span class="doc-stamp">${stamp}</span>
        <h3>Notice of copyright infringement</h3>
        <div class="doc-meta">To: ${meta.name} · ${notice.id} · ${esc(notice.createdAt)}</div>
        <h4>Claimant</h4>
        <p>Northlight Pictures, the rights holder.</p>
        <h4>Signatory</h4>
        <p>${esc(notice.signatory)}, Rights Director.</p>
        <h4>Works identified</h4>
        <ul>${list}</ul>
        <h4>Statements</h4>
        <p>The claimant owns the exclusive rights in each work above. The material identified is not authorised by the claimant, its agents, or the law.</p>
        <div class="sign">${esc(notice.signatory)}<span>Signed at approval · Northlight Pictures</span></div>
      </article>`,
    );
  }

  /* Actions. */
  function handleReview(id, decision, button) {
    const candidate = state.candidates.find((item) => item.id === id);
    if (!candidate) return;
    const card = button.closest(".candidate");
    if (card && card.dataset.busy === "true") return;

    if (decision === "confirm") {
      if (candidate.allowlisted) {
        toast("Allowlisted host. Confirmation blocked.", "amber", "i-lock");
        return;
      }
      if (card) {
        card.dataset.busy = "true";
        card.classList.add("is-busted");
      }
      setTimeout(() => finalizeConfirm(candidate), 640);
      return;
    }

    const meta = DECISIONS[decision];
    if (card) {
      card.dataset.busy = "true";
      card.classList.add("is-leaving");
    }
    setTimeout(() => {
      state.candidates = state.candidates.filter((item) => item.id !== id);
      if (decision === "authorized") {
        const title = titleOf(candidate.titleId);
        const host = hostOf(candidate.url);
        if (title && !title.allowlist.includes(host)) title.allowlist.push(host);
        state.activity.unshift({
          icon: "lock",
          tone: "green",
          text: `Allowlist updated · ${host}.`,
          time: "now",
        });
      }
      state.activity.unshift({
        icon: decision === "dead" ? "x" : "check",
        tone: decision === "dead" ? "amber" : "blue",
        text: `Review · ${meta.label} · ${hostOf(candidate.url)}.`,
        time: "now",
      });
      render();
      toast(meta.message, decision === "dead" ? "amber" : "blue");
    }, 220);
  }

  function finalizeConfirm(candidate) {
    if (!state.candidates.includes(candidate)) return;
    const title = titleOf(candidate.titleId);
    const host = hostOf(candidate.url);
    const seq = String(2400 + state.violations.length).padStart(4, "0");
    state.candidates = state.candidates.filter((item) => item.id !== candidate.id);
    state.violations.unshift({
      id: uid("v"),
      titleId: candidate.titleId,
      host,
      url: candidate.url,
      evidence: {
        id: `EV-${seq}`,
        at: `${timeNow()} UTC`,
        hash: Math.random().toString(16).slice(2, 14).padEnd(12, "0"),
        chain: [`200 → ${host}`],
      },
      state: "open",
      noticeId: null,
    });
    state.activity.unshift({
      icon: "siren",
      tone: "red",
      text: `Violation logged · ${title ? title.name : "Unknown title"}.`,
      time: "now",
    });
    render();
    toast("Violation logged. Evidence sealed.", "red", "i-siren");
  }

  function buildNotice() {
    if (!selected.size) return;
    const citations = [...selected];
    const number = state.nextNotice++;
    const notice = {
      id: `N-${number}`,
      recipient: state.cartRecipient,
      state: "draft",
      citations,
      createdAt: timeNow(),
      signatory: "Mara Voss",
      submission: null,
    };
    state.notices.unshift(notice);
    state.violations.forEach((violation) => {
      if (citations.includes(violation.id)) violation.noticeId = notice.id;
    });
    selected.clear();
    state.activity.unshift({
      icon: "file",
      tone: "amber",
      text: `Notice ${notice.id} drafted for ${engineOf(notice.recipient).name}.`,
      time: "now",
    });
    go("notices");
    toast(`Draft ${notice.id} ready for approval.`, "amber", "i-file");
  }

  function approveNotice(id) {
    const notice = state.notices.find((item) => item.id === id);
    if (!notice || notice.state !== "draft") return;
    notice.state = "approved";
    notice.submission = null;
    state.activity.unshift({
      icon: "check",
      tone: "green",
      text: `Notice ${notice.id} approved · ${engineOf(notice.recipient).name}.`,
      time: "now",
    });
    render();
    toast(`Approved. Ready to send to ${engineOf(notice.recipient).name}.`, "green", "i-check");
  }

  function sendNotice(id) {
    const notice = state.notices.find((item) => item.id === id);
    if (!notice || notice.state !== "approved" || notice.submission) return;
    notice.submission = { state: "pending", at: null };
    state.activity.unshift({
      icon: "send",
      tone: "blue",
      text: `Submission opened · ${notice.id} → ${engineOf(notice.recipient).name}.`,
      time: "now",
    });
    render();
    toast(`Submission opened for ${engineOf(notice.recipient).name}.`, "blue", "i-send");

    setTimeout(() => {
      if (!state.notices.includes(notice)) return;
      if (!notice.submission || notice.submission.state !== "pending") return;
      notice.submission = { state: "delivered", at: timeNow() };
      state.activity.unshift({
        icon: "send",
        tone: "blue",
        text: `Notice ${notice.id} delivered · ${engineOf(notice.recipient).name}.`,
        time: "now",
      });
      render();
      toast("Delivered.", "blue", "i-send");
    }, 950);

    setTimeout(() => {
      if (!state.notices.includes(notice)) return;
      if (!notice.submission || notice.submission.state !== "delivered") return;
      notice.submission = { state: "acknowledged", at: timeNow() };
      state.activity.unshift({
        icon: "check",
        tone: "green",
        text: `${engineOf(notice.recipient).name} acknowledged ${notice.id}.`,
        time: "now",
      });
      render();
      toast(`${engineOf(notice.recipient).name} acknowledged ${notice.id}.`, "green", "i-check");
    }, 2200);
  }

  function runScan() {
    if (state.scanning) return;
    const runId = (state.scanId || 0) + 1;
    state.scanId = runId;
    state.scanning = true;
    scanLine.classList.remove("is-active");
    void scanLine.offsetWidth;
    scanLine.classList.add("is-active");
    updateChrome();

    setTimeout(() => {
      if (state.scanId !== runId) return;
      state.scanning = false;
      scanLine.classList.remove("is-active");
      Object.keys(state.engines).forEach((engine) => {
        state.engines[engine].last = "now";
      });
      const existing = new Set(state.candidates.map((candidate) => candidate.url));
      const fresh = SCAN_POOL.filter((candidate) => !existing.has(candidate.url)).slice(0, 2);
      fresh.forEach((candidate) => {
        const title = titleOf(candidate.titleId);
        const host = hostOf(candidate.url);
        state.candidates.push({
          id: uid("c"),
          ...candidate,
          allowlisted: Boolean(title && title.allowlist.includes(host)),
        });
      });
      state.activity.unshift({
        icon: "radar",
        tone: "blue",
        text: `Scans finished · 3 engines · ${fresh.length} new candidates.`,
        time: "now",
      });
      updateChrome();
      render();
      toast(fresh.length ? `Scans finished · ${fresh.length} new candidates.` : "Scans finished · no new candidates.", "blue", "i-radar");
    }, 2000);
  }

  function go(route) {
    if (currentRoute() === route) {
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      location.hash = `#/${route}`;
    }
  }

  function reset() {
    const fresh = seedState();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, fresh);
    selected.clear();
    updateChrome();
    render();
    toast("Demo reset.", "blue", "i-refresh");
  }

  /* Events. */
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;

    if (action === "scan") runScan();
    if (action === "reset") reset();
    if (action === "review") handleReview(trigger.dataset.id, trigger.dataset.decision, trigger);
    if (action === "evidence") {
      const violation = state.violations.find((item) => item.id === trigger.dataset.id);
      if (violation) evidenceModal(violation);
    }
    if (action === "view-notice") {
      const notice = state.notices.find((item) => item.id === trigger.dataset.id);
      if (notice) noticeModal(notice);
    }
    if (action === "approve-notice") approveNotice(trigger.dataset.id);
    if (action === "send-notice") sendNotice(trigger.dataset.id);
    if (action === "draft-notice") buildNotice();
    if (action === "close-modal") modal.close();
    if (action === "toggle-title") {
      const title = state.titles.find((item) => item.id === trigger.dataset.id);
      if (title) {
        title.paused = !title.paused;
        render();
        toast(title.paused ? `${title.name} paused.` : `${title.name} back on patrol.`, title.paused ? "amber" : "green");
      }
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-select]")) {
      const id = event.target.dataset.select;
      if (event.target.checked) selected.add(id);
      else selected.delete(id);
      render();
    }
    if (event.target.id === "recipient") {
      state.cartRecipient = event.target.value;
    }
  });

  sirenBtn.addEventListener("click", () => {
    const on = sirenBtn.getAttribute("aria-pressed") !== "true";
    sirenBtn.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("siren", on);
    toast(on ? "Siren mode. Eyes up." : "Siren off.", on ? "red" : "blue", "i-siren");
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });

  window.addEventListener("hashchange", () => {
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
  });

  render();
  window.scrollTo(0, 0);
})();
