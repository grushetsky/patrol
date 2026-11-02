/* Patrol pitch deck. Navigation, active-slide choreography, counters. */
(() => {
  "use strict";

  const deck = document.getElementById("deck");
  const slides = [...deck.querySelectorAll(".slide")];
  const dots = document.getElementById("dots");
  const progress = document.getElementById("progress-fill");
  const current = document.getElementById("deck-current");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ratios = new Map(slides.map((slide) => [slide, 0]));
  let active = 0;

  dots.innerHTML = slides
    .map(
      (slide, index) =>
        `<button class="dot" type="button" data-goto="${index}" aria-label="Go to slide ${index + 1}" title="Slide ${index + 1}"></button>`,
    )
    .join("");
  const dotNodes = [...dots.querySelectorAll(".dot")];

  function countTo(element) {
    const target = Number(element.dataset.count || 0);
    if (reduceMotion) {
      element.textContent = target.toLocaleString("en-US");
      return;
    }
    const start = performance.now();
    const duration = 1200;
    const tick = (now) => {
      const progressValue = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progressValue, 3);
      element.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (progressValue < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setActive(index) {
    active = index;
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("is-active", slideIndex === index);
    });
    dotNodes.forEach((dot, dotIndex) => {
      dot.classList.toggle("is-active", dotIndex === index);
      if (dotIndex === index) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    progress.style.width = `${((index + 1) / slides.length) * 100}%`;
    current.textContent = String(index + 1).padStart(2, "0");

    const counters = slides[index].querySelectorAll("[data-count]");
    if (reduceMotion) {
      counters.forEach((element) => {
        element.textContent = Number(element.dataset.count || 0).toLocaleString("en-US");
      });
      return;
    }
    counters.forEach(countTo);
  }

  function go(index) {
    const target = Math.max(0, Math.min(slides.length - 1, index));
    slides[target].scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => ratios.set(entry.target, entry.intersectionRatio));
      let bestIndex = 0;
      let bestRatio = 0;
      slides.forEach((slide, index) => {
        const ratio = ratios.get(slide) || 0;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestIndex = index;
        }
      });
      if (bestRatio > 0.15) setActive(bestIndex);
    },
    {
      root: deck,
      threshold: [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1],
    },
  );

  slides.forEach((slide) => observer.observe(slide));

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-goto]");
    if (!trigger) return;
    go(Number(trigger.dataset.goto));
  });

  document.addEventListener("keydown", (event) => {
    const interactive = event.target.closest("a, button, input, select, textarea");
    if (interactive && (event.key === " " || event.key === "Enter")) return;

    const forward = ["ArrowDown", "ArrowRight", "PageDown", " "];
    const backward = ["ArrowUp", "ArrowLeft", "PageUp"];

    if (forward.includes(event.key)) {
      event.preventDefault();
      go(active + 1);
    } else if (backward.includes(event.key)) {
      event.preventDefault();
      go(active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(0);
    } else if (event.key === "End") {
      event.preventDefault();
      go(slides.length - 1);
    }
  });

  const hero = document.querySelector(".hero");
  const car = document.querySelector(".car-parallax");
  if (hero && car && !reduceMotion) {
    hero.addEventListener("pointermove", (event) => {
      const rect = hero.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      car.style.setProperty("--px", `${(-x * 18).toFixed(1)}px`);
      car.style.setProperty("--py", `${(-y * 12).toFixed(1)}px`);
    });
    hero.addEventListener("pointerleave", () => {
      car.style.setProperty("--px", "0px");
      car.style.setProperty("--py", "0px");
    });
  }

  setActive(0);
})();
