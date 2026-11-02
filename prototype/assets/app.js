/* Patrol service prototype. Throwaway UI; state lives in memory only. */
(() => {
  "use strict";

  const { t, tn } = PatrolI18n;

  const RECIPIENTS = {
    google: { name: "Google", glyph: "G" },
    bing: { name: "Bing", glyph: "b" },
    yandex: { name: "Yandex", glyph: "Y" },
  };

  const DECISIONS = {
    dismiss: { labelKey: "app.review.dismiss", messageKey: "app.review.dismissed" },
    wrong: { labelKey: "app.review.wrong", messageKey: "app.review.wrongMarked" },
    authorized: { labelKey: "app.review.authorized", messageKey: "app.review.authorizedMarked" },
    dead: { labelKey: "app.review.dead", messageKey: "app.review.deadMarked" },
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
    { id: "dashboard", labelKey: "app.nav.dashboard", icon: "i-gauge" },
    { id: "review", labelKey: "app.nav.review", icon: "i-radar" },
    { id: "violations", labelKey: "app.nav.violations", icon: "i-shield" },
    { id: "notices", labelKey: "app.nav.notices", icon: "i-file" },
    { id: "titles", labelKey: "app.nav.titles", icon: "i-film" },
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
  let modalSpec = null;

  function seedState() {
    return {
      scanning: false,
      cartRecipient: "google",
      nextNotice: 1044,
      engines: {
        google: { last: { minutes: 2 } },
        bing: { last: { minutes: 9 } },
        yandex: { last: { minutes: 14 } },
      },
      titles: [
        {
          id: "t1",
          name: "Midnight Precinct",
          original: "Midnight Precinct",
          year: 2024,
          groupKey: "app.group.feature",
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
          groupKey: "app.group.feature",
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
          groupKey: "app.group.winter",
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
          groupKey: "app.group.archive",
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
            at: "20:51 UTC",
            yesterday: true,
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
          createdAt: { time: "03:02" },
          signatory: "Mara Voss",
          submission: null,
        },
        {
          id: "N-1042",
          recipient: "bing",
          state: "approved",
          citations: ["v4"],
          createdAt: { time: "21:08", yesterday: true },
          signatory: "Mara Voss",
          submission: { state: "acknowledged", at: { time: "21:12", yesterday: true } },
        },
      ],
      activity: [
        { icon: "check", tone: "green", textKey: "app.activity.bingAck", params: { id: "N-1042" }, time: { minutes: 2 } },
        { icon: "radar", tone: "blue", textKey: "app.activity.yandexScan", countType: "candidates", count: 2, time: { minutes: 14 } },
        { icon: "siren", tone: "red", textKey: "app.activity.violationLogged", params: { name: "The Long Chase" }, time: { minutes: 41 } },
        { icon: "lock", tone: "green", textKey: "app.activity.allowlistMatch", params: { host: "official.example" }, time: { hours: 1 } },
        { icon: "file", tone: "amber", textKey: "app.activity.noticeDrafted", params: { id: "N-1043", recipient: "Google" }, time: { hours: 1 } },
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
  const timeNow = () =>
    new Date().toLocaleTimeString(PatrolI18n.lang === "ru" ? "ru-RU" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  const uid = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7)}`;

  function formatTime(spec) {
    if (!spec) return "";
    if (spec.minutes === 0) return t("time.now");
    if (spec.minutes) return t("time.minutes", { n: spec.minutes });
    if (spec.hours) return t("time.hours", { n: spec.hours });
    return "";
  }

  function formatWhen(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    return value.yesterday ? t("time.yesterdayAt", { time: value.time }) : value.time;
  }

  function formatEvidenceAt(evidence) {
    return evidence.yesterday ? t("time.yesterdayAt", { time: evidence.at }) : evidence.at;
  }

  function activityLabel(item) {
    const params = { ...(item.params || {}) };
    if (item.countType === "candidates") params.candidates = tn("app.common.candidates", item.count);
    if (item.countType === "newCandidates") params.candidates = tn("app.scan.newCandidates", item.count);
    if (item.decisionKey) params.decision = t(item.decisionKey);
    return t(item.textKey, params);
  }
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
      return `<a class="tab" href="#/${tab.id}"${current}>${icon(tab.icon, "icon--sm")}${t(tab.labelKey)}${badge}</a>`;
    }).join("");

    const activeTab = tabs.querySelector('[aria-current="page"]');
    if (activeTab && tabs.scrollWidth > tabs.clientWidth) {
      const tabRect = activeTab.getBoundingClientRect();
      const tabsRect = tabs.getBoundingClientRect();
      tabs.scrollLeft += tabRect.left - tabsRect.left - (tabsRect.width - tabRect.width) / 2;
    }

    scanBtn.classList.toggle("is-scanning", state.scanning);
    if (state.scanning) {
      scanBtn.disabled = true;
      scanBtn.setAttribute("aria-label", t("app.scan.scanning"));
      scanBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="scan-label">${t("app.scan.scanning")}</span>`;
    } else {
      scanBtn.disabled = false;
      scanBtn.removeAttribute("aria-label");
      scanBtn.innerHTML = `${icon("i-radar", "icon--sm")}<span>${t("app.scan.run")}</span>`;
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
          <span class="when">${esc(formatTime(state.engines[id].last))}</span>
        </div>`,
      )
      .join("");

    const activity = state.activity
      .slice(0, 6)
      .map(
        (item) => `
        <div class="act" data-tone="${item.tone}">
          <span class="act-icon">${icon(ACTIVITY_ICONS[item.icon] || "i-bolt", "icon--sm")}</span>
          <span class="act-text">${esc(activityLabel(item))}</span>
          <span class="act-time">${esc(formatTime(item.time))}</span>
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
            <span class="mini-title">${esc(title ? title.name : t("app.unknownTitle"))}</span>
            <span class="mini-url">${esc(candidate.url)}</span>
          </span>
          <span class="mini-score">${candidate.score}%</span>
        </a>`;
      })
      .join("");

    const health = pending === 0 ? t("app.dashboard.queueClear") : t("app.common.pending", { n: pending });
    const headline =
      open === 0
        ? `${t("app.dashboard.quietLead")} <span class="accent">${t("app.dashboard.forNow")}</span>`
        : `${tn("app.dashboard.openCases", open)} <span class="siren-text">${t("app.dashboard.keepMoving")}</span>`;

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${timeNow()} · ${t("app.dashboard.allEngines")} · <span class="nowrap">${health}</span></p>
            <h1 class="page-title">${headline}</h1>
          </div>
          <p class="head-note">${t("app.dashboard.note")}</p>
        </header>

        <div class="stats">
          <div class="stat" data-tone="red">
            <span class="stat-icon">${icon("i-shield")}</span>
            <div class="stat-num">${open}</div>
            <div class="stat-label">${t("app.dashboard.openViolations")}</div>
          </div>
          <div class="stat" data-tone="amber">
            <span class="stat-icon">${icon("i-radar")}</span>
            <div class="stat-num">${pending}</div>
            <div class="stat-label">${t("app.dashboard.toReview")}</div>
          </div>
          <div class="stat" data-tone="blue">
            <span class="stat-icon">${icon("i-file")}</span>
            <div class="stat-num">${state.notices.length}</div>
            <div class="stat-label">${t("app.dashboard.noticesOnFile")}</div>
          </div>
          <div class="stat" data-tone="green">
            <span class="stat-icon">${icon("i-check")}</span>
            <div class="stat-num">${served}</div>
            <div class="stat-label">${t("app.dashboard.acknowledged")}</div>
          </div>
        </div>

        <div class="dash-grid">
          <div class="dash-col">
            <div class="panel">
              <div class="panel-head"><span>${t("app.dashboard.activity")}</span><a href="#/notices">${t("app.dashboard.noticesLink")} ${icon("i-arrow", "icon--sm")}</a></div>
              <div class="panel-body activity">${activity}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><span>${t("app.dashboard.latest")}</span><a href="#/review">${t("app.dashboard.reviewLink")} ${icon("i-arrow", "icon--sm")}</a></div>
              <div class="panel-body">${
                latest ||
                `<p class="muted" style="padding:10px;font-size:12px">${t("app.dashboard.noCandidates")}</p>`
              }</div>
            </div>
          </div>

          <div class="dash-col">
            <div class="radar-card">
              <div class="panel-head"><span>${t("app.dashboard.liveSweep")}</span><span class="chip chip--live"><span class="dot"></span>${t("app.dashboard.watching")}</span></div>
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
                <span style="color:var(--red)"><i></i>${t("app.dashboard.violation")}</span>
                <span style="color:var(--amber)"><i></i>${t("app.dashboard.candidate")}</span>
                <span style="color:var(--blue)"><i></i>${t("app.dashboard.clean")}</span>
              </div>
              <div class="engines">${engines}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><span>${t("app.dashboard.guardrails")}</span><span class="chip chip--muted">${tn("app.common.titles", pages)}</span></div>
              <div class="panel-body" style="padding:14px 16px">
                <p class="muted" style="margin:0 0 10px;font-size:12px">${t("app.dashboard.guardrailsNote")}</p>
                <div class="candidate-meta">
                  <span class="chip chip--blue">${icon("i-lock", "icon--sm")}${t("app.dashboard.allowlistEnforced")}</span>
                  <span class="chip">${t("app.dashboard.immutableEvidence")}</span>
                  <span class="chip">${t("app.dashboard.oneQueue")}</span>
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
        <h2>${t("app.review.emptyTitle")}</h2>
        <p>${t("app.review.emptyBody")}</p>
        <button class="btn btn-primary" type="button" data-action="scan">${icon("i-radar", "icon--sm")}${t("app.scan.run")}</button>
      </div>`;

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.review.eyebrow")} · ${t("app.common.pending", { n: state.candidates.length })}</p>
            <h1 class="page-title">${t("app.review.title")}</h1>
          </div>
          <p class="head-note">${t("app.review.note")}</p>
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
          ${t(meta.labelKey)}
        </button>`,
      )
      .join("");

    return `
      <article class="candidate" data-id="${candidate.id}">
        <span class="candidate-thumb">${icon("i-film", "icon--sm")}</span>
        <div class="candidate-body">
          <div class="candidate-top">
            <div style="min-width:0">
              <h3 class="candidate-title">${esc(title ? title.name : t("app.unknownTitle"))} <span>· ${title ? title.year : "—"}</span></h3>
              <span class="candidate-url">${esc(candidate.url)}</span>
            </div>
          </div>
          <div class="candidate-meta">
            <span class="chip chip--blue">${icon("i-globe", "icon--sm")}${engine.name}</span>
            <span class="chip">${t("app.review.rank", { n: candidate.rank })}</span>
            <span class="chip">${esc(hostOf(candidate.url))}</span>
            ${locked ? `<span class="chip chip--locked">${icon("i-lock", "icon--sm")}${t("app.review.allowlisted")}</span>` : ""}
          </div>
          <div class="candidate-actions">
            <button class="btn btn-danger btn-sm btn-confirm" type="button" data-action="review" data-id="${candidate.id}" data-decision="confirm" ${
              locked ? `disabled title="${t("app.review.allowlistedTitle")}"` : ""
            }>${icon("i-siren", "icon--sm")}${t("app.review.confirm")}</button>
            ${actions}
          </div>
        </div>
        <div class="candidate-score">
          <span class="score-num" data-level="${level}">${candidate.score}%</span>
          <span class="score-track"><span class="score-fill" style="width:${candidate.score}%"></span></span>
          <span class="score-label">${t("app.review.match")}</span>
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
          <input class="check" type="checkbox" aria-label="${t("app.violations.select", { host: violation.host })}" data-select="${violation.id}" ${
            picked ? "checked" : ""
          } ${canPick ? "" : "disabled"} />
          <div style="min-width:0">
            <div class="v-title">${esc(title ? title.name : t("app.unknownTitle"))} <span class="v-host-name muted">· ${esc(violation.host)}</span></div>
            <div class="v-host">${icon("i-link", "icon--sm")}${esc(violation.url)}</div>
          </div>
          <div class="v-evidence">
            <button class="btn-evidence" type="button" data-action="evidence" data-id="${violation.id}">${icon("i-lock", "icon--sm")}${esc(violation.evidence.id)}</button>
            <span>${esc(formatEvidenceAt(violation.evidence))}</span>
          </div>
          <div class="v-status">
            ${
              inNotice && violation.state === "open"
                ? `<span class="chip chip--amber">${t("app.violations.inNotice")}</span>`
                : violation.state === "removed"
                  ? `<span class="chip chip--muted">${t("app.violations.removed")}</span>`
                  : `<span class="chip chip--danger"><span class="dot"></span>${t("app.violations.open")}</span>`
            }
          </div>
        </div>`;
      })
      .join("");

    const cart = selected.size
      ? `<div class="cart">
          <span class="cart-count"><b>${selected.size}</b> ${t("app.violations.selected")}</span>
          <select class="select" id="recipient" aria-label="${t("app.violations.recipient")}">
            ${Object.entries(RECIPIENTS)
              .map(
                ([id, meta]) =>
                  `<option value="${id}" ${state.cartRecipient === id ? "selected" : ""}>${meta.name}</option>`,
              )
              .join("")}
          </select>
          <button class="btn btn-primary btn-sm" type="button" data-action="draft-notice">${icon("i-file", "icon--sm")}${t("app.violations.draft")}</button>
        </div>`
      : "";

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.violations.eyebrow")} · ${t("app.violations.openCount", { n: openViolations().length })}</p>
            <h1 class="page-title">${t("app.violations.title")}</h1>
          </div>
          <p class="head-note">${t("app.violations.note")}</p>
        </header>
        ${
          rows
            ? rows
            : `<div class="empty">
                <span class="empty-icon">${icon("i-shield", "icon--lg")}</span>
                <h2>${t("app.violations.emptyTitle")}</h2>
                <p>${t("app.violations.emptyBody")}</p>
                <a class="btn btn-primary" href="#/review">${icon("i-radar", "icon--sm")}${t("app.violations.goReview")}</a>
              </div>`
        }
        ${cart}
      </section>`;
  }

  function noticeState(notice) {
    if (notice.submission && notice.submission.state === "acknowledged") return { key: "app.notices.status.acknowledged", cls: "chip--live" };
    if (notice.submission && notice.submission.state === "delivered") return { key: "app.notices.status.delivered", cls: "chip--blue" };
    if (notice.submission && notice.submission.state === "pending") return { key: "app.notices.status.sending", cls: "chip--amber" };
    if (notice.state === "approved") return { key: "app.notices.status.approved", cls: "chip--blue" };
    return { key: "app.notices.status.draft", cls: "chip--amber" };
  }

  function stepper(notice) {
    const delivered = notice.submission && ["delivered", "acknowledged"].includes(notice.submission.state);
    const acknowledged = notice.submission && notice.submission.state === "acknowledged";
    const approved = notice.state === "approved" || delivered || acknowledged;
    const steps = [
      { key: "app.notices.step.draft", done: true },
      { key: "app.notices.step.approved", done: approved },
      { key: "app.notices.step.delivered", done: delivered || acknowledged },
      { key: "app.notices.step.acknowledged", done: acknowledged },
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
        return `<span class="step ${cls}"><span class="step-dot"></span>${t(step.key)}</span>${line}`;
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
              <div class="notice-sub">${tn("app.notices.violations", count)} · ${esc(notice.signatory)} · ${t("app.notices.drafted", {
                when: formatWhen(notice.createdAt),
              })}${
                notice.submission && notice.submission.at
                  ? ` · ${t("app.notices.sent", { when: formatWhen(notice.submission.at) })}`
                  : ""
              }</div>
            </div>
            <span class="chip ${status.cls}">${t(status.key)}</span>
            <div class="notice-actions">
              ${
                notice.state === "draft"
                  ? `<button class="btn btn-primary btn-sm" type="button" data-action="approve-notice" data-id="${notice.id}">${icon("i-check", "icon--sm")}${t("app.notices.approve")}</button>`
                  : approved && !notice.submission
                    ? `<button class="btn btn-primary btn-sm" type="button" data-action="send-notice" data-id="${notice.id}">${icon("i-send", "icon--sm")}${t("app.notices.send")}</button>`
                    : approved && sending
                      ? `<button class="btn btn-sm" type="button" disabled><span class="spinner"></span>${t("app.notices.sending")}</button>`
                      : ""
              }
              <button class="btn btn-ghost btn-sm" type="button" data-action="view-notice" data-id="${notice.id}">${icon("i-eye", "icon--sm")}${t("app.notices.view")}</button>
            </div>
          </div>
          <div class="notice-body">
            ${stepper(notice)}
            <div class="notice-doc-cta">
              ${icon("i-globe", "icon--sm")}${t(count > 1 ? "app.notices.recipientMany" : "app.notices.recipientOne", { recipient: meta.name })}
              <button type="button" data-action="view-notice" data-id="${notice.id}">${t("app.notices.openDocument")}</button>
            </div>
          </div>
        </article>`;
      })
      .join("");

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.notices.eyebrow")} · ${t("app.notices.awaiting", { n: draftNotices().length })}</p>
            <h1 class="page-title">${t("app.notices.title")}</h1>
          </div>
          <p class="head-note">${t("app.notices.note")}</p>
        </header>
        ${cards || `<div class="empty"><span class="empty-icon">${icon("i-file", "icon--lg")}</span><h2>${t("app.notices.emptyTitle")}</h2><p>${t("app.notices.emptyBody")}</p><a class="btn btn-primary" href="#/violations">${icon("i-shield", "icon--sm")}${t("app.notices.openViolations")}</a></div>`}
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
            <div class="title-sub">${title.year} · ${esc(t(title.groupKey))}</div>
            <div class="title-meta">
              <span class="chip">${tn("app.titles.variants", title.variants)}</span>
              <span class="chip">${title.allowlist.length ? t("app.titles.allowlistedCount", { n: title.allowlist.length }) : t("app.titles.noAllowlist")}</span>
              ${
                title.paused
                  ? `<span class="chip chip--muted"><span class="dot"></span>${t("app.titles.paused")}</span>`
                  : `<span class="chip chip--live"><span class="dot"></span>${t("app.titles.watching")}</span>`
              }
            </div>
          </div>
          <div class="title-side">
            <button class="switch" type="button" role="switch" aria-checked="${!title.paused}" aria-label="${t("app.titles.toggle", {
              name: title.name,
            })}" data-action="toggle-title" data-id="${title.id}"><span class="switch-thumb"></span></button>
            ${title.allowlist.length ? `<span class="chip chip--muted">${tn("app.titles.rules", title.allowlist.length)}</span>` : ""}
          </div>
        </article>`,
      )
      .join("");

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.titles.eyebrow")} · ${tn("app.common.titles", state.titles.length)}</p>
            <h1 class="page-title">${t("app.titles.title")}</h1>
          </div>
          <p class="head-note">${t("app.titles.note")}</p>
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
      t("app.evidence.title", { id: evidence.id }),
      `<dl class="evidence-grid">
        <div class="ev-row"><dt>${t("app.evidence.titleField")}</dt><dd>${esc(title ? title.name : t("app.evidence.unknown"))}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.url")}</dt><dd>${esc(violation.url)}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.host")}</dt><dd>${esc(violation.host)}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.captured")}</dt><dd>${esc(formatEvidenceAt(evidence))}</dd></div>
        <div class="ev-row"><dt>SHA-256</dt><dd>${esc(evidence.hash)}</dd></div>
      </dl>
      <div class="chain">${evidence.chain.map((hop) => `<span>${esc(hop)}</span>`).join("<i>→</i>")}</div>
      <p class="muted" style="margin:16px 0 0;font-size:11.5px">${t("app.evidence.note")}</p>`,
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
        return `<li>${esc(title ? title.name : t("app.unknownTitle"))} — ${esc(violation.host)}<br /><span class="doc-cite">${esc(violation.url)} · ${t(
          "app.notices.evidence",
        )} ${esc(violation.evidence.id)} · ${esc(formatEvidenceAt(violation.evidence))}</span></li>`;
      })
      .join("");
    const stamp = notice.submission
      ? t("app.notices.stamp.served")
      : notice.state === "approved"
        ? t("app.notices.stamp.approved")
        : t("app.notices.stamp.draft");
    openModal(
      `${t("app.nav.notices")} · ${notice.id}`,
      `<article class="doc">
        <span class="doc-stamp">${stamp}</span>
        <h3>${t("app.notices.docTitle")}</h3>
        <div class="doc-meta">${t("app.notices.docTo", {
          recipient: meta.name,
          id: notice.id,
          when: formatWhen(notice.createdAt),
        })}</div>
        <h4>${t("app.notices.claimant")}</h4>
        <p>${t("app.notices.claimantName")}</p>
        <h4>${t("app.notices.signatory")}</h4>
        <p>${t("app.notices.signatoryName", { name: notice.signatory })}</p>
        <h4>${t("app.notices.works")}</h4>
        <ul>${list}</ul>
        <h4>${t("app.notices.statements")}</h4>
        <p>${t("app.notices.statement")}</p>
        <div class="sign">${esc(notice.signatory)}<span>${t("app.notices.signedAt")}</span></div>
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
        toast(t("app.review.allowlistBlocked"), "amber", "i-lock");
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
          textKey: "app.activity.allowlistUpdated",
          params: { host },
          time: { minutes: 0 },
        });
      }
      state.activity.unshift({
        icon: decision === "dead" ? "x" : "check",
        tone: decision === "dead" ? "amber" : "blue",
        textKey: "app.activity.review",
        params: { host: hostOf(candidate.url) },
        decisionKey: meta.labelKey,
        time: { minutes: 0 },
      });
      render();
      toast(t(meta.messageKey), decision === "dead" ? "amber" : "blue");
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
      textKey: "app.activity.violationLogged",
      params: { name: title ? title.name : t("app.unknownTitle") },
      time: { minutes: 0 },
    });
    render();
    toast(t("app.review.confirmed"), "red", "i-siren");
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
      createdAt: { time: timeNow() },
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
      textKey: "app.activity.noticeDrafted",
      params: { id: notice.id, recipient: engineOf(notice.recipient).name },
      time: { minutes: 0 },
    });
    go("notices");
    toast(t("app.notices.draftToast", { id: notice.id }), "amber", "i-file");
  }

  function approveNotice(id) {
    const notice = state.notices.find((item) => item.id === id);
    if (!notice || notice.state !== "draft") return;
    notice.state = "approved";
    notice.submission = null;
    state.activity.unshift({
      icon: "check",
      tone: "green",
      textKey: "app.activity.noticeApproved",
      params: { id: notice.id, recipient: engineOf(notice.recipient).name },
      time: { minutes: 0 },
    });
    render();
    toast(t("app.notices.approvedToast", { recipient: engineOf(notice.recipient).name }), "green", "i-check");
  }

  function sendNotice(id) {
    const notice = state.notices.find((item) => item.id === id);
    if (!notice || notice.state !== "approved" || notice.submission) return;
    notice.submission = { state: "pending", at: null };
    state.activity.unshift({
      icon: "send",
      tone: "blue",
      textKey: "app.activity.submissionOpened",
      params: { id: notice.id, recipient: engineOf(notice.recipient).name },
      time: { minutes: 0 },
    });
    render();
    toast(t("app.notices.submissionOpened", { recipient: engineOf(notice.recipient).name }), "blue", "i-send");

    setTimeout(() => {
      if (!state.notices.includes(notice)) return;
      if (!notice.submission || notice.submission.state !== "pending") return;
      notice.submission = { state: "delivered", at: { time: timeNow() } };
      state.activity.unshift({
        icon: "send",
        tone: "blue",
        textKey: "app.activity.noticeDelivered",
        params: { id: notice.id, recipient: engineOf(notice.recipient).name },
        time: { minutes: 0 },
      });
      render();
      toast(t("app.notices.delivered"), "blue", "i-send");
    }, 950);

    setTimeout(() => {
      if (!state.notices.includes(notice)) return;
      if (!notice.submission || notice.submission.state !== "delivered") return;
      notice.submission = { state: "acknowledged", at: { time: timeNow() } };
      state.activity.unshift({
        icon: "check",
        tone: "green",
        textKey: "app.activity.acknowledged",
        params: { recipient: engineOf(notice.recipient).name, id: notice.id },
        time: { minutes: 0 },
      });
      render();
      toast(t("app.notices.acknowledged", { recipient: engineOf(notice.recipient).name, id: notice.id }), "green", "i-check");
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
        state.engines[engine].last = { minutes: 0 };
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
        textKey: "app.activity.scansFinished",
        params: { engines: 3 },
        countType: "newCandidates",
        count: fresh.length,
        time: { minutes: 0 },
      });
      updateChrome();
      render();
      toast(
        fresh.length
          ? t("app.scan.finished", { candidates: tn("app.scan.newCandidates", fresh.length) })
          : t("app.scan.none"),
        "blue",
        "i-radar",
      );
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
    toast(t("app.reset.toast"), "blue", "i-refresh");
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
      if (violation) {
        modalSpec = { type: "evidence", id: violation.id };
        evidenceModal(violation);
      }
    }
    if (action === "view-notice") {
      const notice = state.notices.find((item) => item.id === trigger.dataset.id);
      if (notice) {
        modalSpec = { type: "notice", id: notice.id };
        noticeModal(notice);
      }
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
        toast(
          title.paused ? t("app.titles.pausedToast", { name: title.name }) : t("app.titles.resumedToast", { name: title.name }),
          title.paused ? "amber" : "green",
        );
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
    toast(on ? t("app.siren.on") : t("app.siren.off"), on ? "red" : "blue", "i-siren");
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });

  modal.addEventListener("close", () => {
    modalSpec = null;
  });

  PatrolI18n.onChange(() => {
    toasts.replaceChildren();
    updateChrome();
    render();
    if (modal.open && modalSpec) {
      if (modalSpec.type === "evidence") {
        const violation = state.violations.find((item) => item.id === modalSpec.id);
        if (violation) evidenceModal(violation);
      }
      if (modalSpec.type === "notice") {
        const notice = state.notices.find((item) => item.id === modalSpec.id);
        if (notice) noticeModal(notice);
      }
    }
  });

  window.addEventListener("hashchange", () => {
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
  });

  render();
  window.scrollTo(0, 0);
})();
