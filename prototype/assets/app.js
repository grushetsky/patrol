/* Patrol service prototype. Throwaway UI; state lives in memory only. */
(() => {
  "use strict";

  const { t, tn } = PatrolI18n;

  const RECIPIENTS = {
    google: { name: "Google", glyph: "G" },
    bing: { name: "Bing", glyph: "B" },
    yandex: { name: "Yandex", glyph: "Я" },
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


  const KINOPOISK_CATALOG = [
    {
      id: "1044716",
      name: "Мастер и Маргарита",
      original: "The Master and Margarita",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 3,
      glow: "rgba(139, 123, 255, 0.5)",
      aliases: ["master and margarita", "bulgakov", "булгаков"],
    },
    {
      id: "4951188",
      name: "Слово пацана. Кровь на асфальте",
      original: "The Boy's Word: Blood on the Asphalt",
      year: 2023,
      type: "series",
      groupKey: "app.group.feature",
      variants: 4,
      glow: "rgba(255, 61, 94, 0.42)",
      aliases: ["slovo patsana", "patsana", "asphalt"],
    },
    {
      id: "4540123",
      name: "Дюна: Часть вторая",
      original: "Dune: Part Two",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.4)",
      aliases: ["dune part two", "дюна"],
    },
    {
      id: "5450139",
      name: "Анора",
      original: "Anora",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.36)",
      aliases: ["anora"],
    },
    {
      id: "5123456",
      name: "Лёд 3",
      original: "Ice 3",
      year: 2024,
      type: "film",
      groupKey: "app.group.winter",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.45)",
      aliases: ["led 3", "ice three", "лёд"],
    },
    {
      id: "5041234",
      name: "Холоп 2",
      original: "The Serf 2",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(139, 123, 255, 0.4)",
      aliases: ["holop 2", "the serf"],
    },
    {
      id: "5221234",
      name: "Сто лет тому вперёд",
      original: "Guest from the Future",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(47, 214, 165, 0.35)",
      aliases: ["sto let tomu vpered", "guest from the future"],
    },
    {
      id: "5321234",
      name: "Фишер",
      original: "Fisher",
      year: 2023,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 176, 32, 0.35)",
      aliases: ["fisher"],
    },
    {
      id: "4649634",
      name: "Кибердеревня",
      original: "Cybervillage",
      year: 2023,
      type: "series",
      groupKey: "app.group.winter",
      variants: 3,
      glow: "rgba(61, 139, 255, 0.42)",
      aliases: ["cybervillage", "кибер"],
    },
    {
      id: "251733",
      name: "Великая",
      original: "The Great",
      year: 2015,
      type: "series",
      groupKey: "app.group.archive",
      variants: 4,
      glow: "rgba(139, 123, 255, 0.4)",
      aliases: ["the great", "великая"],
    },
    {
      id: "1327803",
      name: "Майор Гром: Чумной Доктор",
      original: "Major Grom: Plague Doctor",
      year: 2021,
      type: "film",
      groupKey: "app.group.feature",
      variants: 3,
      glow: "rgba(255, 61, 94, 0.42)",
      aliases: ["major grom", "plague doctor", "майор гром", "чумной доктор"],
    },
    {
      id: "5020232",
      name: "Майор Гром: Игра",
      original: "Major Grom: The Game",
      year: 2024,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.4)",
      aliases: ["major grom game", "майор гром игра"],
    },
    {
      id: "4364241",
      name: "Чебурашка",
      original: "Cheburashka",
      year: 2022,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.38)",
      aliases: ["cheburashka", "чебурашка"],
    },
    {
      id: "4644361",
      name: "Вызов",
      original: "The Challenge",
      year: 2023,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.44)",
      aliases: ["the challenge", "vychov", "вызов"],
    },
    {
      id: "915039",
      name: "Движение вверх",
      original: "Three Seconds",
      year: 2017,
      type: "film",
      groupKey: "app.group.feature",
      variants: 3,
      glow: "rgba(47, 214, 165, 0.36)",
      aliases: ["three seconds", "dvizhenie vverh", "движение вверх"],
    },
    {
      id: "895722",
      name: "Салют-7",
      original: "Salyut-7",
      year: 2017,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(139, 123, 255, 0.42)",
      aliases: ["salyut 7", "salyut-7", "салют"],
    },
    {
      id: "930992",
      name: "Притяжение",
      original: "Attraction",
      year: 2017,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.4)",
      aliases: ["attraction", "prityazhenie", "притяжение"],
    },
    {
      id: "46225",
      name: "Солярис",
      original: "Solaris",
      year: 1972,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 176, 32, 0.34)",
      aliases: ["solaris", "solyaris", "тарковский", "солярис"],
    },
    {
      id: "44721",
      name: "Сталкер",
      original: "Stalker",
      year: 1979,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(47, 214, 165, 0.32)",
      aliases: ["stalker", "сталкер", "тарковский"],
    },
    {
      id: "44806",
      name: "Москва слезам не верит",
      original: "Moscow Does Not Believe in Tears",
      year: 1980,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.32)",
      aliases: ["moscow does not believe in tears", "moskva slezam ne verit", "москва слезам"],
    },
    {
      id: "43870",
      name: "Ирония судьбы, или С лёгким паром!",
      original: "The Irony of Fate, or Enjoy Your Bath!",
      year: 1975,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(139, 123, 255, 0.38)",
      aliases: ["irony of fate", "ironiya sudby", "ирония судьбы", "с легким паром"],
    },
    {
      id: "44127",
      name: "Служебный роман",
      original: "Office Romance",
      year: 1977,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.34)",
      aliases: ["office romance", "sluzhebny roman", "служебный роман"],
    },
    {
      id: "464317",
      name: "Кухня",
      original: "Kitchen",
      year: 2012,
      type: "series",
      groupKey: "app.group.archive",
      variants: 5,
      glow: "rgba(255, 176, 32, 0.38)",
      aliases: ["kitchen", "kuhnya", "кухня"],
    },
    {
      id: "464411",
      name: "Интерны",
      original: "Interns",
      year: 2010,
      type: "series",
      groupKey: "app.group.archive",
      variants: 4,
      glow: "rgba(47, 214, 165, 0.34)",
      aliases: ["interns", "interny", "интерны"],
    },
    {
      id: "807339",
      name: "Метод",
      original: "The Method",
      year: 2015,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 61, 94, 0.34)",
      aliases: ["the method", "metod", "метод"],
    },
    {
      id: "43963",
      name: "Иван Васильевич меняет профессию",
      original: "Ivan Vasilievich Changes Profession",
      year: 1973,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 176, 32, 0.36)",
      aliases: ["ivan vasilievich", "иван васильевич", "булгаков"],
    },
    {
      id: "43938",
      name: "Кавказская пленница, или Новые приключения Шурика",
      original: "Kidnapping, Caucasian Style",
      year: 1966,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(47, 214, 165, 0.32)",
      aliases: ["caucasian style", "кавказская пленница", "шурик"],
    },
    {
      id: "43943",
      name: "Бриллиантовая рука",
      original: "The Diamond Arm",
      year: 1968,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(61, 139, 255, 0.36)",
      aliases: ["diamond arm", "brilliantovaya ruka", "бриллиантовая рука"],
    },
    {
      id: "43944",
      name: "Джентльмены удачи",
      original: "Gentlemen of Fortune",
      year: 1971,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.32)",
      aliases: ["gentlemen of fortune", "dzhentlmeny udachi", "джентльмены удачи"],
    },
    {
      id: "43957",
      name: "Место встречи изменить нельзя",
      original: "The Meeting Place Cannot Be Changed",
      year: 1979,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(139, 123, 255, 0.36)",
      aliases: ["meeting place", "место встречи", "жеглов"],
    },
    {
      id: "43966",
      name: "Семнадцать мгновений весны",
      original: "Seventeen Moments of Spring",
      year: 1973,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 176, 32, 0.34)",
      aliases: ["seventeen moments of spring", "семнадцать мгновений", "штирлиц"],
    },
    {
      id: "43971",
      name: "Война и мир",
      original: "War and Peace",
      year: 1965,
      type: "film",
      groupKey: "app.group.archive",
      variants: 4,
      glow: "rgba(255, 176, 32, 0.32)",
      aliases: ["war and peace", "война и мир", "толстой"],
    },
    {
      id: "44005",
      name: "Андрей Рублёв",
      original: "Andrei Rublev",
      year: 1966,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(139, 123, 255, 0.32)",
      aliases: ["andrei rublev", "андрей рублев", "тарковский"],
    },
    {
      id: "44159",
      name: "Иди и смотри",
      original: "Come and See",
      year: 1985,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.34)",
      aliases: ["come and see", "иди и смотри"],
    },
    {
      id: "43977",
      name: "Летят журавли",
      original: "The Cranes Are Flying",
      year: 1957,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.32)",
      aliases: ["cranes are flying", "летят журавли"],
    },
    {
      id: "43981",
      name: "Белое солнце пустыни",
      original: "White Sun of the Desert",
      year: 1970,
      type: "film",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(255, 176, 32, 0.34)",
      aliases: ["white sun of the desert", "белое солнце пустыни", "сухов"],
    },
    {
      id: "43982",
      name: "Д'Артаньян и три мушкетёра",
      original: "D'Artagnan and Three Musketeers",
      year: 1978,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(139, 123, 255, 0.34)",
      aliases: ["dartagnan", "три мушкетера", "д'артаньян"],
    },
    {
      id: "44115",
      name: "Гардемарины, вперёд!",
      original: "Midshipmen, Forward!",
      year: 1987,
      type: "series",
      groupKey: "app.group.archive",
      variants: 3,
      glow: "rgba(61, 139, 255, 0.34)",
      aliases: ["midshipmen forward", "гардемарины", "вперед"],
    },
    {
      id: "44116",
      name: "Кин-дза-дза!",
      original: "Kin-dza-dza!",
      year: 1986,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.32)",
      aliases: ["kin dza dza", "кин дза дза", "пацак"],
    },
    {
      id: "44117",
      name: "Чародеи",
      original: "The Magicians",
      year: 1982,
      type: "film",
      groupKey: "app.group.archive",
      variants: 2,
      glow: "rgba(47, 214, 165, 0.32)",
      aliases: ["magicians", "чародеи"],
    },
    {
      id: "464438",
      name: "О чём говорят мужчины",
      original: "What Men Talk About",
      year: 2010,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.34)",
      aliases: ["what men talk about", "о чем говорят мужчины", "мужчины"],
    },
    {
      id: "679947",
      name: "Горько!",
      original: "Gorko!",
      year: 2013,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.32)",
      aliases: ["gorko", "горько", "свадьба"],
    },
    {
      id: "517989",
      name: "Ёлки",
      original: "Six Degrees of Celebration",
      year: 2010,
      type: "film",
      groupKey: "app.group.winter",
      variants: 3,
      glow: "rgba(47, 214, 165, 0.34)",
      aliases: ["yolki", "елки", "six degrees of celebration"],
    },
    {
      id: "535724",
      name: "Левиафан",
      original: "Leviathan",
      year: 2014,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.34)",
      aliases: ["leviathan", "левиафан", "зывягинцев"],
    },
    {
      id: "500031",
      name: "Дылда",
      original: "Beanpole",
      year: 2019,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(139, 123, 255, 0.32)",
      aliases: ["beanpole", "дылда", "балагов"],
    },
    {
      id: "1355056",
      name: "Купе номер шесть",
      original: "Compartment No. 6",
      year: 2021,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 176, 32, 0.32)",
      aliases: ["compartment no 6", "купе номер шесть", "купе"],
    },
    {
      id: "1179163",
      name: "Финист. Первый богатырь",
      original: "Finist: The First Bogatyr",
      year: 2025,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(255, 61, 94, 0.34)",
      aliases: ["finist", "финист", "богатырь"],
    },
    {
      id: "523532",
      name: "Волшебник Изумрудного города. Дорога из жёлтого кирпича",
      original: "The Wizard of the Emerald City",
      year: 2025,
      type: "film",
      groupKey: "app.group.feature",
      variants: 3,
      glow: "rgba(47, 214, 165, 0.34)",
      aliases: ["wizard of the emerald city", "волшебник изумрудного города", "изумрудный город"],
    },
    {
      id: "508161",
      name: "Сердце пармы",
      original: "The Heart of Parma",
      year: 2022,
      type: "film",
      groupKey: "app.group.feature",
      variants: 2,
      glow: "rgba(61, 139, 255, 0.34)",
      aliases: ["heart of parma", "сердце пармы", "парма"],
    },
  ];

  const ACTIVITY_ICONS = {
    siren: "i-siren",
    radar: "i-radar",
    check: "i-check",
    file: "i-file",
    lock: "i-lock",
    send: "i-send",
    film: "i-film",
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

  const ROUTES = new Set([...TABS.map((tab) => tab.id), "settings"]);
  const DEEPSEEK_STORAGE_KEY = "patrol.deepseek.key";
  const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

  /* Chart configuration and demo history. */
  const CHART_METRICS = [
    { id: "tracked", labelKey: "app.chart.metricTracked" },
    { id: "withViolations", labelKey: "app.chart.metricWithViolations" },
    { id: "resolved", labelKey: "app.chart.metricResolved" },
  ];
  const CHART_GROUPINGS = [
    { id: "none", labelKey: "app.chart.groupNone" },
    { id: "group", labelKey: "app.chart.groupGroup" },
    { id: "engine", labelKey: "app.chart.groupEngine" },
    { id: "recipient", labelKey: "app.chart.groupRecipient" },
  ];
  const CHART_COLORS = ["var(--red)", "var(--blue)", "var(--amber)", "var(--green)"];
  const CHART_DAYS = 30;
  const DEMO_STATES = ["normal", "loading", "quota", "empty"];

  function buildHistory() {
    const titles = [
      { id: "t1", groupKey: "app.group.feature" },
      { id: "t2", groupKey: "app.group.feature" },
      { id: "t3", groupKey: "app.group.winter" },
      { id: "t4", groupKey: "app.group.archive" },
    ];
    const engines = ["google", "bing", "yandex"];
    const recipients = ["google", "bing", "yandex"];
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const records = [];
    for (let index = 0; index < 24; index += 1) {
      const title = titles[Math.floor(random() * titles.length)];
      const detectedDay = Math.floor(random() * 28);
      const resolved = detectedDay >= 25 ? random() < 0.5 : true;
      records.push({
        id: `h${index}`,
        titleId: title.id,
        groupKey: title.groupKey,
        engine: engines[Math.floor(random() * engines.length)],
        recipient: recipients[Math.floor(random() * recipients.length)],
        detectedDay,
        resolvedDay: resolved ? Math.min(CHART_DAYS - 1, detectedDay + 1 + Math.floor(random() * 3)) : null,
        resolution: random() < 0.5 ? "removed" : "closed",
      });
    }
    return records;
  }

  const HISTORY = buildHistory();

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
      demoState: "normal",
      reviewDensity: "rows",
      violationTitleFilter: "all",
      chartMetric: "withViolations",
      chartGrouping: "group",
      chartRange: 14,
      chartSelected: null,
      resolvedBasis: "removed_closed",
      deepseekBrief: null,
      deepseekBriefMode: null,
      deepseekLoading: false,
      deepseekError: null,
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
          finalUrl: "https://cdn.stream-hub.example/embed/2291",
          host: "cdn.stream-hub.example",
          domain: "stream-hub.example",
          engine: "google",
          titleId: "t1",
          rank: 1,
          score: 97,
          allowlisted: false,
          variant: { value: "Midnight Precinct", kind: "canonical", language: "en", script: "Latn", territory: "US" },
          query: "midnight precinct full movie",
          locale: "en-US",
          territory: "US",
          evidence: { id: "EV-2382", hash: "7c1e9a4b0f22", at: "03:01 UTC", thumb: "player" },
          allowlist: { status: "none" },
          reputation: { domain: "stream-hub.example", count: 2, bonus: 0.02 },
          priorDecisions: [],
          components: { title: 0.7, signals: [{ key: "player", value: 0.25 }], reputation: 0.02 },
        },
        {
          id: "c2",
          url: "https://magnetbay.example/torrent/8841",
          finalUrl: "https://magnetbay.example/torrent/8841",
          host: "magnetbay.example",
          domain: "magnetbay.example",
          engine: "yandex",
          titleId: "t3",
          rank: 3,
          score: 95,
          allowlisted: false,
          variant: { value: "Neon Pursuit", kind: "localized", language: "ru", script: "Cyrl", territory: "RU" },
          query: "неоновый погоня смотреть",
          locale: "ru-RU",
          territory: "RU",
          evidence: { id: "EV-2381", hash: "b81e4cc902af", at: "02:44 UTC", thumb: "download" },
          allowlist: { status: "none" },
          reputation: { domain: "magnetbay.example", count: 6, bonus: 0.05 },
          priorDecisions: [{ decision: "page_dead", when: "4d ago" }],
          components: {
            title: 0.6,
            signals: [
              { key: "duration", value: 0.25 },
              { key: "release", value: 0.05 },
            ],
            reputation: 0.05,
          },
        },
        {
          id: "c3",
          url: "https://official.example/premiere/midnight-precinct",
          finalUrl: "https://official.example/premiere/midnight-precinct",
          host: "official.example",
          domain: "official.example",
          engine: "bing",
          titleId: "t1",
          rank: 1,
          score: 97,
          allowlisted: true,
          variant: { value: "Midnight Precinct", kind: "canonical", language: "en", script: "Latn", territory: "US" },
          query: "midnight precinct premiere",
          locale: "en-US",
          territory: "US",
          evidence: { id: "EV-2380", hash: "2ad7c1f90b64", at: "02:40 UTC", thumb: "player" },
          allowlist: { status: "hit", entry: "official.example", kind: "official_domain", scope: "rights_holder" },
          reputation: { domain: "official.example", count: 2, bonus: 0.02 },
          priorDecisions: [],
          components: { title: 0.7, signals: [{ key: "player", value: 0.25 }], reputation: 0.02 },
        },
        {
          id: "c4",
          url: "https://vk-video.example/video-2291",
          finalUrl: "https://vk-video.example/video-2291",
          host: "vk-video.example",
          domain: "vk-video.example",
          engine: "google",
          titleId: "t2",
          rank: 6,
          score: 70,
          allowlisted: false,
          variant: { value: "The Long Chase", kind: "canonical", language: "en", script: "Latn", territory: "US" },
          query: "the long chase 2023",
          locale: "en-US",
          territory: "US",
          evidence: { id: "EV-2379", hash: "4a7d90fe12c8", at: "02:31 UTC", thumb: "page" },
          allowlist: { status: "none" },
          reputation: { domain: "vk-video.example", count: 0, bonus: 0 },
          priorDecisions: [{ decision: "not_a_violation", when: "12d ago" }],
          components: { title: 0.7, signals: [], reputation: 0 },
        },
      ],
      allowlistEntries: [
        {
          id: "a1",
          kind: "official_domain",
          value: "official.example",
          scope: "rights_holder",
          target: null,
          territory: null,
          source: "operator",
        },
        {
          id: "a2",
          kind: "official_domain",
          value: "festival.example",
          scope: "title",
          target: "t3",
          territory: null,
          source: "operator",
        },
        {
          id: "a3",
          kind: "licensed_destination",
          value: "partner.example",
          scope: "group",
          target: "app.group.feature",
          territory: "US",
          source: "review",
        },
        {
          id: "a4",
          kind: "neutral_source",
          value: "wikipedia.example",
          scope: "rights_holder",
          target: null,
          territory: null,
          source: "learned",
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

  function getDeepSeekKey() {
    try {
      return (localStorage.getItem(DEEPSEEK_STORAGE_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function saveDeepSeekKey(value) {
    try {
      localStorage.setItem(DEEPSEEK_STORAGE_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  function clearDeepSeekKey() {
    try {
      localStorage.removeItem(DEEPSEEK_STORAGE_KEY);
    } catch {
      /* Ignore unavailable storage. */
    }
  }

  function localDeepSeekBrief() {
    return t("app.deepseek.localBrief", {
      pending: tn("app.common.candidates", state.candidates.length),
      open: openViolations().length,
    });
  }


  const normalizeSearch = (value) =>
    String(value)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  function levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const current = row[j];
        row[j] = Math.min(
          row[j] + 1,
          row[j - 1] + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        previous = current;
      }
    }
    return row[b.length];
  }

  function kinopoiskScore(record, query) {
    const needle = normalizeSearch(query);
    if (needle.length < 2) return 0;
    const fields = [record.name, record.original, String(record.year), ...(record.aliases || [])].map(normalizeSearch);
    let score = 0;
    for (const field of fields) {
      if (field.includes(needle)) score = Math.max(score, 100 - Math.min(field.indexOf(needle), 25));
      for (const word of field.split(" ").filter(Boolean)) {
        const distance = levenshtein(needle, word);
        const similarity = 1 - distance / Math.max(needle.length, word.length);
        if (similarity >= 0.7) score = Math.max(score, Math.round(similarity * 80));
      }
    }
    return score;
  }

  function searchKinoPoisk(query) {
    const needle = normalizeSearch(query);
    if (needle.length < 2) return [];
    return KINOPOISK_CATALOG.map((record) => ({ record, score: kinopoiskScore(record, query) }))
      .filter((entry) => entry.score >= 45)
      .sort((a, b) => b.score - a.score || a.record.year - b.record.year || a.record.name.localeCompare(b.record.name))
      .slice(0, 8);
  }

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
  const openViolations = () => visibleViolations().filter((violation) => violation.state === "open");
  const draftNotices = () => visibleNotices().filter((notice) => notice.state === "draft");

  function currentRoute() {
    const route = location.hash.replace(/^#\/?/, "");
    return ROUTES.has(route) ? route : "dashboard";
  }

  function render() {
    const route = currentRoute();
    const renderers = {
      dashboard: renderDashboard,
      review: renderReview,
      violations: renderViolations,
      notices: renderNotices,
      titles: renderTitles,
      settings: renderSettings,
    };
    view.innerHTML = renderers[route]();
    updateChrome();
  }

  function updateChrome() {
    const route = currentRoute();
    const counts = {
      review: displayCandidates().length,
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

    document.querySelectorAll(".proto-bar [data-state]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.state === state.demoState));
    });

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
  function quotaBanner() {
    if (state.demoState !== "quota") return "";
    return `<div class="banner banner--amber" role="status">
      ${icon("i-gauge", "icon--sm")}
      <span><b>${t("app.quota.title")}</b> ${t("app.quota.body")}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-action="demo-state" data-state="normal">${t("app.quota.resume")}</button>
    </div>`;
  }

  function renderDashboard() {
    const empty = state.demoState === "empty";
    const pending = displayCandidates().length;
    const open = empty ? 0 : openViolations().length;
    const served = empty ? 0 : state.notices.filter((notice) => notice.submission && notice.submission.state === "acknowledged").length;

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
          <span class="engine-badge" data-engine="${id}"><span class="engine-glyph">${meta.glyph}</span></span>
          <span class="name">${meta.name}</span>
          ${
            state.demoState === "quota" && id === "google"
              ? `<span class="chip chip--amber engine-quota">${t("app.quota.engine")}</span>`
              : ""
          }
        </div>`,
      )
      .join("");

    const activity = state.activity
      .slice(0, 5)
      .map(
        (item) => `
        <div class="act" data-tone="${item.tone}">
          <span class="act-icon">${icon(ACTIVITY_ICONS[item.icon] || "i-bolt", "icon--sm")}</span>
          <span class="act-text">${esc(activityLabel(item))}</span>
          <span class="act-time">${esc(formatTime(item.time))}</span>
        </div>`,
      )
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
            <p class="eyebrow"><span class="dot"></span>${timeNow()} · ${
              state.demoState === "quota" ? t("app.dashboard.enginesUp", { n: 2 }) : t("app.dashboard.allEngines")
            }<span class="nowrap"> · ${health}</span></p>
            <h1 class="page-title">${headline}</h1>
          </div>
        </header>
        ${quotaBanner()}

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
            <div class="stat-num">${empty ? 0 : state.notices.length}</div>
            <div class="stat-label">${t("app.dashboard.noticesOnFile")}</div>
          </div>
          <div class="stat" data-tone="green">
            <span class="stat-icon">${icon("i-check")}</span>
            <div class="stat-num">${served}</div>
            <div class="stat-label">${t("app.dashboard.acknowledged")}</div>
          </div>
        </div>

        <div class="dash-grid">
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

          <div class="panel activity-panel">
            <div class="panel-head"><span>${t("app.dashboard.activity")}</span><a href="#/notices">${t("app.dashboard.noticesLink")} ${icon("i-arrow", "icon--sm")}</a></div>
            <div class="panel-body activity">${activity}</div>
          </div>
        </div>
        ${renderInsights()}
      </section>`;
  }


  /* Chart. */
  function trendDayLabel(index, count) {
    return index === count - 1 ? t("app.chart.today") : t("app.chart.daysAgo", { n: count - 1 - index });
  }

  function chartGroups(grouping) {
    if (grouping === "group") {
      return [
        { key: "app.group.feature", label: t("app.group.feature") },
        { key: "app.group.winter", label: t("app.group.winter") },
        { key: "app.group.archive", label: t("app.group.archive") },
      ];
    }
    if (grouping === "engine" || grouping === "recipient") {
      return Object.entries(RECIPIENTS).map(([key, meta]) => ({ key, label: meta.name }));
    }
    return [{ key: "total", label: t("app.chart.total") }];
  }

  function chartData() {
    const metric = CHART_METRICS.some((item) => item.id === state.chartMetric) ? state.chartMetric : "withViolations";
    const grouping = CHART_GROUPINGS.some((item) => item.id === state.chartGrouping) ? state.chartGrouping : "none";
    const range = [7, 14, 30].includes(state.chartRange) ? state.chartRange : 14;
    const applicable =
      (metric === "tracked" && (grouping === "none" || grouping === "group")) ||
      (metric === "withViolations" && grouping !== "recipient") ||
      metric === "resolved";
    const effectiveGrouping = applicable ? grouping : "none";
    const groups = chartGroups(effectiveGrouping);
    const start = CHART_DAYS - range;
    const days = Array.from({ length: range }, (_, index) => start + index);
    const paused = new Set(state.titles.filter((title) => title.paused).map((title) => title.id));
    const active = (record, day) =>
      record.detectedDay <= day && (record.resolvedDay === null || record.resolvedDay > day);
    const resolvedOn = (record, day) => {
      if (record.resolvedDay !== day) return false;
      if (state.resolvedBasis === "closed") return record.resolution === "closed";
      return true;
    };
    const valuesFor = (key, day) => {
      if (metric === "tracked") {
        return state.titles.filter((title) => !paused.has(title.id) && (key === "total" || title.groupKey === key)).length;
      }
      if (metric === "withViolations") {
        const titles = new Set();
        HISTORY.forEach((record) => {
          if (!active(record, day)) return;
          if (key !== "total") {
            if (effectiveGrouping === "group" && record.groupKey !== key) return;
            if (effectiveGrouping === "engine" && record.engine !== key) return;
          }
          if (!paused.has(record.titleId)) titles.add(record.titleId);
        });
        return titles.size;
      }
      return HISTORY.filter((record) => {
        if (!resolvedOn(record, day)) return false;
        if (key === "total") return true;
        if (effectiveGrouping === "group") return record.groupKey === key;
        if (effectiveGrouping === "engine") return record.engine === key;
        if (effectiveGrouping === "recipient") return record.recipient === key;
        return true;
      }).length;
    };
    return {
      metric,
      grouping: effectiveGrouping,
      requestedGrouping: grouping,
      applicable,
      range,
      start,
      days,
      series: groups.map((group, index) => ({
        ...group,
        color: CHART_COLORS[index % CHART_COLORS.length],
        values: days.map((day) => valuesFor(group.key, day)),
      })),
    };
  }

  let lastChart = null;

  function niceStep(value) {
    const power = 10 ** Math.floor(Math.log10(Math.max(1, value)));
    const norm = value / power;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * power;
  }

  function chartInspectorHtml(data, index) {
    if (index === null || index === undefined || !data) {
      return `<span class="trend-inspector-hint">${esc(t("app.chart.inspect"))}</span>`;
    }
    const label = trendDayLabel(index, data.days.length);
    const values = data.series.map((series) => `${series.label}: ${series.values[index]}`).join(" · ");
    return `<span class="trend-inspector-date">${esc(label)}</span><span class="trend-inspector-values">${esc(values)}</span>`;
  }

  function renderChartSvg(data) {
    const width = 720;
    const height = 240;
    const pad = { left: 38, right: 18, top: 18, bottom: 32 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const count = data.days.length;
    const maxValue = Math.max(...data.series.flatMap((series) => series.values), 1);
    const step = niceStep(maxValue / 4);
    const topValue = step * 4;
    const x = (index) => pad.left + (count === 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
    const y = (value) => pad.top + plotHeight - (value / topValue) * plotHeight;
    const path = (values) =>
      values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
    const bottom = pad.top + plotHeight;
    const ticks = [0, 1, 2, 3, 4].map((index) => index * step);
    const grid = ticks
      .map(
        (tick) =>
          `<line class="trend-grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" />` +
          `<text class="trend-axis trend-axis--y" x="${pad.left - 10}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${tick}</text>`,
      )
      .join("");
    const labelIndexes = [0, Math.floor((count - 1) / 2), count - 1];
    const xLabels = labelIndexes
      .map((index) => {
        const label = trendDayLabel(index, count);
        const anchor = index === 0 ? "start" : index === count - 1 ? "end" : "middle";
        return `<text class="trend-axis" x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${esc(label)}</text>`;
      })
      .join("");
    const selected =
      Number.isInteger(state.chartSelected) && state.chartSelected >= 0 && state.chartSelected < count
        ? state.chartSelected
        : null;
    const hitWidth = plotWidth / count;
    const hits = data.days
      .map(
        (day, index) =>
          `<rect class="trend-hit" data-action="chart-select" data-index="${index}" x="${(pad.left + index * hitWidth).toFixed(
            1,
          )}" y="${pad.top}" width="${hitWidth.toFixed(1)}" height="${plotHeight}" fill="transparent" ${
            selected === index ? 'data-selected="true"' : ""
          } />`,
      )
      .join("");
    const guide =
      selected === null
        ? ""
        : `<line class="trend-guide" x1="${x(selected).toFixed(1)}" x2="${x(selected).toFixed(1)}" y1="${pad.top}" y2="${bottom}" />`;
    const area =
      data.series.length === 1
        ? `M${x(0).toFixed(1)} ${bottom.toFixed(1)} ${data.series[0].values
            .map((value, index) => `L${x(index).toFixed(1)} ${y(value).toFixed(1)}`)
            .join(" ")} L${x(count - 1).toFixed(1)} ${bottom.toFixed(1)} Z`
        : "";
    const lines = data.series
      .map(
        (series) =>
          `<path class="trend-line" style="stroke:${series.color}" d="${path(series.values)}" />` +
          `<circle class="trend-dot" style="fill:${series.color}" cx="${x(count - 1).toFixed(1)}" cy="${y(
            series.values[series.values.length - 1],
          ).toFixed(1)}" r="3.5" />`,
      )
      .join("");
    return `<svg class="trend-chart" data-count="${count}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      t("app.chart.aria"),
    )}">
        ${grid}
        ${area ? `<path class="trend-area" d="${area}" />` : ""}
        ${lines}
        ${guide}
        ${hits}
        ${xLabels}
      </svg>`;
  }

  function renderInsights() {
    if (state.demoState === "loading") {
      return `<div class="insight-grid">
        <section class="panel trend-panel">
          <div class="panel-head"><span>${t("app.chart.title")}</span></div>
          <div class="trend-body"><div class="skeleton skeleton--chart" aria-busy="true"></div></div>
        </section>
        ${renderDeepSeekCard()}
      </div>`;
    }
    const data = chartData();
    lastChart = data;
    const totals = data.series.map((series) => series.values.reduce((sum, value) => sum + value, 0));
    const today = CHART_DAYS - 1;
    const pausedIds = new Set(state.titles.filter((title) => title.paused).map((title) => title.id));
    const activeToday = HISTORY.filter(
      (record) =>
        record.detectedDay <= today &&
        (record.resolvedDay === null || record.resolvedDay > today) &&
        !pausedIds.has(record.titleId),
    );
    const activeTitles = new Set(activeToday.map((record) => record.titleId)).size;
    const affectedGroups = new Set(activeToday.map((record) => record.groupKey)).size;
    const latest =
      data.metric === "withViolations"
        ? activeTitles
        : data.series.reduce((sum, series) => sum + series.values[series.values.length - 1], 0);
    const dailyTotals = data.days.map((_, index) =>
      data.series.reduce((sum, series) => sum + series.values[index], 0),
    );
    const peak = Math.max(...dailyTotals, 0);
    const pausedCount = state.titles.filter((title) => title.paused).length;
    const removedCount = HISTORY.filter(
      (record) => record.resolvedDay >= data.start && record.resolution === "removed",
    ).length;
    const closedCount = HISTORY.filter(
      (record) => record.resolvedDay >= data.start && record.resolution === "closed",
    ).length;
    const kpis =
      data.metric === "tracked"
        ? [
            [latest, t("app.chart.kpiTracked")],
            [pausedCount, t("app.chart.kpiPaused")],
            [new Set(state.titles.map((title) => title.groupKey)).size, t("app.chart.kpiGroups")],
          ]
        : data.metric === "withViolations"
          ? [
              [latest, t("app.chart.kpiWithViolations")],
              [affectedGroups, t("app.chart.kpiAffected")],
              [peak, t("app.chart.kpiPeak")],
            ]
          : [
              [totals.reduce((sum, value) => sum + value, 0), t("app.chart.kpiResolved")],
              [removedCount, t("app.chart.kpiRemoved")],
              [closedCount, t("app.chart.kpiClosed")],
            ];
    const metricTabs = CHART_METRICS.map(
      (metric) =>
        `<button class="chart-tab" type="button" data-action="chart-metric" data-metric="${metric.id}" aria-pressed="${
          data.metric === metric.id
        }">${t(metric.labelKey)}</button>`,
    ).join("");
    const grouping = `<select class="select select--sm" id="chart-grouping" aria-label="${esc(t("app.chart.grouping"))}">
      ${CHART_GROUPINGS.map(
        (item) =>
          `<option value="${item.id}" ${data.requestedGrouping === item.id ? "selected" : ""}>${t(item.labelKey)}</option>`,
      ).join("")}
    </select>`;
    const rangeSwitch = `<div class="trend-range-switch" role="group" aria-label="${esc(t("app.chart.range"))}">
      ${[7, 14, 30]
        .map(
          (range) =>
            `<button class="trend-range-btn" type="button" data-action="chart-range" data-range="${range}" aria-pressed="${
              data.range === range
            }">${t("app.chart.rangeN", { n: range })}</button>`,
        )
        .join("")}
    </div>`;
    const basisSwitch =
      data.metric === "resolved"
        ? `<div class="chart-basis" role="group" aria-label="${esc(t("app.chart.resolvedBasis"))}">
            <button class="chart-tab" type="button" data-action="resolved-basis" data-basis="removed_closed" aria-pressed="${
              state.resolvedBasis !== "closed"
            }">${t("app.chart.basisRemovedClosed")}</button>
            <button class="chart-tab" type="button" data-action="resolved-basis" data-basis="closed" aria-pressed="${
              state.resolvedBasis === "closed"
            }">${t("app.chart.basisClosed")}</button>
          </div>`
        : "";
    const legend = data.series
      .map(
        (series) =>
          `<span class="trend-legend-item"><i class="legend-dot" style="background:${series.color}"></i>${esc(series.label)}</span>`,
      )
      .join("");
    const noteKey =
      data.metric === "tracked"
        ? "app.chart.noteTracked"
        : data.metric === "withViolations"
          ? "app.chart.noteWithViolations"
          : "app.chart.noteResolved";
    const notApplicable =
      data.applicable || data.requestedGrouping === "none"
        ? ""
        : `<span class="chart-hint">${
            data.metric === "tracked" ? t("app.chart.groupNotApplicableTracked") : t("app.chart.groupNotApplicable")
          }</span>`;
    const inspector = chartInspectorHtml(data, state.chartSelected);

    return `<div class="insight-grid">
      <section class="panel trend-panel">
        <div class="panel-head"><span>${t("app.chart.title")}</span><div class="chart-controls">${rangeSwitch}${grouping}</div></div>
        <div class="trend-body">
          <div class="chart-toolbar">${metricTabs}${basisSwitch}</div>
          ${notApplicable}
          <div class="trend-kpis">
            ${kpis
              .map(
                ([value, label]) =>
                  `<div class="trend-kpi"><span class="trend-kpi-num">${value}</span><span class="trend-kpi-label">${esc(label)}</span></div>`,
              )
              .join("")}
          </div>
          ${renderChartSvg(data)}
          <div class="trend-legend">${legend}</div>
          <div class="trend-inspector" id="trend-inspector" aria-live="polite">${inspector}</div>
          <p class="chart-note">${t(noteKey)}</p>
        </div>
      </section>
      ${renderDeepSeekCard()}
    </div>`;
  }

  function renderDeepSeekCard() {
    const configured = Boolean(getDeepSeekKey());
    const brief = state.deepseekBrief;
    const loading = state.deepseekLoading;
    const local = state.deepseekBriefMode === "local";
    return `<section class="panel deepseek-panel">
      <div class="panel-head">
        <span class="deepseek-head">${icon("i-spark", "icon--sm")}${t("app.deepseek.title")}</span>
        <span class="chip ${configured ? "chip--live" : "chip--muted"}">${configured ? t("app.deepseek.ready") : t("app.deepseek.notSet")}</span>
      </div>
      <div class="deepseek-body">
        <p class="deepseek-lede">${t(configured ? "app.deepseek.connectedLede" : "app.deepseek.emptyLede")}</p>
        <div class="deepseek-context">
          <span class="deepseek-context-label">${t("app.deepseek.context")}</span>
          <div class="deepseek-context-stats">
            <span><b>${openViolations().length}</b>${t("app.deepseek.open")}</span>
            <span><b>${state.candidates.length}</b>${t("app.deepseek.queued")}</span>
            <span><b>${state.notices.length}</b>${t("app.deepseek.notices")}</span>
          </div>
          <p>${t("app.deepseek.contextNote")}</p>
        </div>
        ${
          brief
            ? `<div class="deepseek-brief"><span class="deepseek-brief-head">${t(
                local ? "app.deepseek.localBriefTitle" : "app.deepseek.brief",
              )}</span><p>${esc(brief)}</p></div>`
            : ""
        }
        ${loading ? `<div class="deepseek-loading"><span class="spinner" aria-hidden="true"></span>${t("app.deepseek.generating")}</div>` : ""}
        <div class="deepseek-actions">
          ${
            configured
              ? `<button class="btn btn-primary btn-sm" type="button" data-action="deepseek-brief" ${
                  loading ? "disabled" : ""
                }>${icon("i-spark", "icon--sm")}${t(brief ? "app.deepseek.refresh" : "app.deepseek.generate")}</button>`
              : `<a class="btn btn-primary btn-sm" href="#/settings">${t("app.deepseek.configure")}</a>`
          }
          ${configured ? `<a class="deepseek-link" href="#/settings">${t("app.deepseek.settings")}</a>` : ""}
        </div>
        ${local ? `<p class="deepseek-note">${t("app.deepseek.localNote")}</p>` : ""}
      </div>
    </section>`;
  }

  function allowlistKindLabel(kind) {
    const keys = {
      official_domain: "app.allowlist.kindOfficial",
      licensed_destination: "app.allowlist.kindLicensed",
      neutral_source: "app.allowlist.kindNeutral",
    };
    return t(keys[kind] || "app.allowlist.kindOfficial");
  }

  function allowlistScopeLabel(entry) {
    if (entry.scope === "rights_holder") return t("app.allowlist.scopeRightsHolder");
    if (entry.scope === "group") return t(entry.target);
    const title = titleOf(entry.target);
    return title ? title.name : t("app.unknownTitle");
  }

  function renderAllowlistPanel() {
    const entries = state.allowlistEntries
      .map(
        (entry) => `<div class="allowlist-row">
          <span class="chip">${esc(allowlistKindLabel(entry.kind))}</span>
          <span class="allowlist-value">${esc(entry.value)}</span>
          <span class="rv-sub">${esc(allowlistScopeLabel(entry))}</span>
          <span class="rv-sub">${esc(entry.territory || "*")}</span>
          <span class="chip chip--muted">${esc(entry.source)}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-action="allowlist-remove" data-id="${entry.id}">${t("app.allowlist.remove")}</button>
        </div>`,
      )
      .join("");
    const targets = [
      ...new Set(state.titles.map((title) => title.groupKey)),
    ]
      .map((groupKey) => `<option value="${esc(groupKey)}">${t("app.allowlist.groupOption", { name: t(groupKey) })}</option>`)
      .concat(
        state.titles.map(
          (title) => `<option value="${esc(title.id)}">${t("app.allowlist.titleOption", { name: title.name })}</option>`,
        ),
      )
      .join("");
    return `<section class="panel settings-panel settings-panel--wide">
      <div class="panel-head">
        <span>${t("app.allowlist.title")}</span>
        <span class="chip chip--muted">${t("app.allowlist.count", { n: state.allowlistEntries.length })}</span>
      </div>
      <div class="settings-body">
        <p class="settings-lede">${t("app.allowlist.lede")}</p>
        <div class="allowlist-table">
          <div class="allowlist-row allowlist-row--head" aria-hidden="true">
            <span>${t("app.allowlist.colKind")}</span>
            <span>${t("app.allowlist.colValue")}</span>
            <span>${t("app.allowlist.colScope")}</span>
            <span>${t("app.allowlist.colTerritory")}</span>
            <span>${t("app.allowlist.colSource")}</span>
            <span></span>
          </div>
          ${entries}
        </div>
        <form id="allowlist-form" class="allowlist-form">
          <select class="select" name="kind" aria-label="${esc(t("app.allowlist.colKind"))}">
            <option value="official_domain">${t("app.allowlist.kindOfficial")}</option>
            <option value="licensed_destination">${t("app.allowlist.kindLicensed")}</option>
            <option value="neutral_source">${t("app.allowlist.kindNeutral")}</option>
          </select>
          <input class="settings-input" name="value" type="text" placeholder="${esc(t("app.allowlist.valuePlaceholder"))}" aria-label="${esc(
            t("app.allowlist.colValue"),
          )}" required />
          <select class="select" name="scope" aria-label="${esc(t("app.allowlist.colScope"))}">
            <option value="rights_holder">${t("app.allowlist.scopeRightsHolder")}</option>
            <option value="group">${t("app.allowlist.scopeGroup")}</option>
            <option value="title">${t("app.allowlist.scopeTitle")}</option>
          </select>
          <select class="select" name="target" aria-label="${esc(t("app.allowlist.colTarget"))}">${targets}</select>
          <input class="settings-input settings-input--short" name="territory" type="text" placeholder="*" aria-label="${esc(
            t("app.allowlist.colTerritory"),
          )}" />
          <button class="btn btn-primary" type="submit">${icon("i-plus", "icon--sm")}${t("app.allowlist.add")}</button>
        </form>
        <p class="settings-hint">${t("app.allowlist.hint")}</p>
      </div>
    </section>`;
  }

  function renderSettings() {
    const key = getDeepSeekKey();
    const configured = Boolean(key);
    const last4 = key.slice(-4);
    return `<section class="page settings-page">
      <header class="page-head">
        <div>
          <p class="eyebrow"><span class="dot"></span>${t("app.settings.eyebrow")}</p>
          <h1 class="page-title">${t("app.settings.title")}</h1>
        </div>
      </header>
      ${renderAllowlistPanel()}
      <div class="settings-grid">
        <section class="panel settings-panel">
          <div class="panel-head">
            <span>${t("app.deepseek.title")}</span>
            <span class="chip ${configured ? "chip--live" : "chip--muted"}">${configured ? t("app.deepseek.ready") : t("app.deepseek.notSet")}</span>
          </div>
          <div class="settings-body">
            <p class="settings-lede">${t("app.deepseek.settingsLede")}</p>
            <form id="deepseek-form" class="settings-form">
              <label class="settings-field" for="deepseek-key">
                <span>${t("app.deepseek.keyLabel")}</span>
                <input class="settings-input" id="deepseek-key" name="deepseek-key" type="password" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${esc(
                  configured ? t("app.deepseek.replacePlaceholder") : t("app.deepseek.keyPlaceholder"),
                )}" />
              </label>
              <p class="settings-hint">${t("app.deepseek.keyHint")}</p>
              <div class="settings-actions">
                <button class="btn btn-primary" type="submit">${icon("i-spark", "icon--sm")}${t("app.deepseek.save")}</button>
                ${
                  configured
                    ? `<button class="btn btn-ghost" type="button" data-action="clear-deepseek">${t("app.deepseek.clear")}</button>`
                    : ""
                }
              </div>
            </form>
            ${configured ? `<div class="settings-saved">${t("app.deepseek.savedStatus", { last4 })}</div>` : ""}
          </div>
        </section>
        <aside class="panel settings-side">
          <div class="panel-head"><span>${t("app.settings.how")}</span></div>
          <div class="settings-body">
            <p>${t("app.deepseek.privacy")}</p>
            <dl class="settings-meta">
              <div><dt>${t("app.deepseek.model")}</dt><dd>${t("app.deepseek.modelValue")}</dd></div>
              <div><dt>${t("app.deepseek.endpoint")}</dt><dd>api.deepseek.com</dd></div>
            </dl>
            <a class="deepseek-link" href="https://api-docs.deepseek.com/" target="_blank" rel="noreferrer">${t("app.deepseek.apiLink")} ↗</a>
          </div>
        </aside>
      </div>
    </section>`;
  }

  async function generateDeepSeekBrief() {
    const key = getDeepSeekKey();
    if (!key) {
      toast(t("app.deepseek.keyRequired"), "amber", "i-spark");
      go("settings");
      return;
    }
    if (state.deepseekLoading) return;
    state.deepseekLoading = true;
    state.deepseekError = null;
    render();

    const snapshot = {
      language: PatrolI18n.lang === "ru" ? "Russian" : "English",
      openViolations: openViolations().length,
      candidatesToReview: state.candidates.length,
      noticesOnFile: state.notices.length,
      acknowledged: state.notices.filter((notice) => notice.submission && notice.submission.state === "acknowledged").length,
      trackedTitles: state.titles.map((title) => title.name),
      recentActivity: state.activity.slice(0, 5).map(activityLabel),
    };
    const fallback = localDeepSeekBrief();
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content:
                "You are Patrol, an anti-piracy operations assistant. Write a concise, practical 2-3 sentence triage brief for a dashboard. Use only the provided data. Do not invent titles or numbers. Answer in the requested language.",
            },
            { role: "user", content: JSON.stringify(snapshot) },
          ],
          temperature: 0.2,
          max_tokens: 180,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DeepSeek ${response.status}`);
      const data = await response.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text || !String(text).trim()) throw new Error("Empty DeepSeek response");
      state.deepseekBrief = String(text).trim();
      state.deepseekBriefMode = "remote";
      toast(t("app.deepseek.readyToast"), "green", "i-spark");
    } catch (error) {
      state.deepseekBrief = fallback;
      state.deepseekBriefMode = "local";
      state.deepseekError = error && error.message ? error.message : "DeepSeek unavailable";
      toast(t("app.deepseek.failedFallback"), "amber", "i-spark");
    } finally {
      if (timer) clearTimeout(timer);
      state.deepseekLoading = false;
      render();
    }
  }

  function displayCandidates() {
    return state.demoState === "empty" ? [] : state.candidates;
  }

  function visibleViolations() {
    return state.demoState === "empty" ? [] : state.violations;
  }

  function visibleNotices() {
    return state.demoState === "empty" ? [] : state.notices;
  }

  function scoreFormula(candidate) {
    const components = candidate.components || { title: 0, signals: [], reputation: 0 };
    const parts = [components.title, ...(components.signals || []).map((signal) => signal.value), components.reputation]
      .filter((value) => value > 0)
      .map((value) => value.toFixed(2));
    return parts.join(" + ");
  }

  function scoreComponentsLabel(candidate) {
    const components = candidate.components || { title: 0, signals: [], reputation: 0 };
    const parts = [t("app.review.titleComponent")];
    (components.signals || []).forEach((signal) => parts.push(t(`app.signal.${signal.key}`)));
    if (components.reputation > 0) parts.push(t("app.review.reputation"));
    return parts.join(" · ");
  }

  function candidateActions(candidate, compact = false) {
    const locked = candidate.allowlisted;
    const menuActions = ["wrong", "authorized", "dead"]
      .map((decision) => {
        const meta = DECISIONS[decision];
        return `<button class="btn btn-ghost btn-sm" type="button" data-action="review" data-id="${candidate.id}" data-decision="${decision}">
          ${t(meta.labelKey)}
        </button>`;
      })
      .join("");
    return `<div class="candidate-actions ${compact ? "candidate-actions--compact" : ""}">
      <button class="btn btn-danger btn-confirm ${compact ? "btn-sm" : ""}" type="button" data-action="review" data-id="${candidate.id}" data-decision="confirm" ${
        locked ? `disabled title="${t("app.review.allowlistedTitle")}"` : ""
      }>${icon("i-siren", "icon--sm")}${t("app.review.confirm")}</button>
      <button class="btn btn-ghost ${compact ? "btn-sm" : ""}" type="button" data-action="review" data-id="${candidate.id}" data-decision="dismiss">${t(
        "app.review.dismiss",
      )}</button>
      <details class="decision-menu">
        <summary class="btn btn-ghost ${compact ? "btn-sm" : ""}">${t("app.review.more")}</summary>
        <div class="decision-menu-panel">${menuActions}</div>
      </details>
    </div>`;
  }

  function renderReview() {
    const candidates = displayCandidates();
    const density = state.reviewDensity === "cards" ? "cards" : "rows";
    const densitySwitch = `<div class="density-switch" role="group" aria-label="${esc(t("app.review.density"))}">
      <button class="chart-tab" type="button" data-action="review-density" data-density="rows" aria-pressed="${density === "rows"}">${t(
        "app.review.densityRows",
      )}</button>
      <button class="chart-tab" type="button" data-action="review-density" data-density="cards" aria-pressed="${density === "cards"}">${t(
        "app.review.densityCards",
      )}</button>
    </div>`;
    const skeleton = `<div class="review-table review-table--loading" aria-busy="true">
      ${Array.from({ length: 3 })
        .map(
          () => `<div class="review-row review-row--skeleton">
            <span class="skeleton skeleton--score"></span>
            <span class="skeleton skeleton--wide"></span>
            <span class="skeleton"></span>
            <span class="skeleton"></span>
            <span class="skeleton skeleton--short"></span>
          </div>`,
        )
        .join("")}
    </div>`;
    const empty = `
      <div class="empty">
        <span class="empty-icon">${icon("i-shield", "icon--lg")}</span>
        <h2>${t("app.review.emptyTitle")}</h2>
        <p>${t("app.review.emptyBody")}</p>
        <button class="btn btn-primary" type="button" data-action="scan">${icon("i-radar", "icon--sm")}${t("app.scan.run")}</button>
      </div>`;
    const body =
      state.demoState === "loading"
        ? skeleton
        : density === "cards"
          ? `<div class="queue" id="queue">${candidates.map((candidate) => candidateCard(candidate)).join("") || empty}</div>`
          : candidates.length
            ? `<div class="review-table" id="queue">
                <div class="review-head" aria-hidden="true">
                  <span>${t("app.review.colScore")}</span>
                  <span>${t("app.review.colWork")}</span>
                  <span>${t("app.review.colUrl")}</span>
                  <span>${t("app.review.colSource")}</span>
                  <span>${t("app.review.colEvidence")}</span>
                  <span>${t("app.review.colFlags")}</span>
                  <span></span>
                </div>
                ${candidates.map((candidate) => candidateRow(candidate)).join("")}
              </div>`
            : empty;

    return `
      <section class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.review.eyebrow")} · ${t("app.common.pending", { n: candidates.length })}</p>
            <h1 class="page-title">${t("app.review.title")}</h1>
          </div>
          ${densitySwitch}
        </header>
        ${quotaBanner()}
        ${body}
        <p class="page-note">${t("app.review.note")}</p>
      </section>`;
  }

  function candidateRow(candidate) {
    const title = titleOf(candidate.titleId);
    const engine = engineOf(candidate.engine);
    const level = scoreLevel(candidate.score);
    const variant = candidate.variant || {};
    const evidence = candidate.evidence || {};
    const reputation = candidate.reputation || {};
    const prior = candidate.priorDecisions || [];
    const allowlist = candidate.allowlist || { status: "none" };
    return `
      <article class="review-row" data-id="${candidate.id}">
        <div class="rv-score">
          <span class="score-num" data-level="${level}">${candidate.score}</span>
          <span class="rv-formula">${scoreFormula(candidate)}</span>
          <span class="score-track"><span class="score-fill" style="width:${candidate.score}%"></span></span>
        </div>
        <div class="rv-work">
          <div class="rv-title">${esc(title ? title.name : t("app.unknownTitle"))} <span class="muted">· ${title ? title.year : "—"}</span></div>
          <span class="chip chip--blue">${esc(variant.value || "—")}</span>
          <div class="rv-sub">${esc(variant.kind || "")} · ${esc(variant.language || "")} · ${esc(variant.script || "")} · ${esc(
            variant.territory || "",
          )}</div>
        </div>
        <div class="rv-url">
          <span class="rv-url-main">${esc(candidate.url)}</span>
          ${candidate.finalUrl && candidate.finalUrl !== candidate.url ? `<span class="rv-sub">→ ${esc(candidate.finalUrl)}</span>` : ""}
          <span class="rv-sub">${esc(candidate.host || hostOf(candidate.url))} · ${esc(candidate.domain || "")}</span>
        </div>
        <div class="rv-source">
          <span class="rv-engine">${esc(engine.name)} · ${t("app.review.rank", { n: candidate.rank })}</span>
          <span class="rv-sub">${esc(candidate.query || "")}</span>
          <span class="rv-sub">${esc(candidate.locale || "")} · ${esc(candidate.territory || "")}</span>
        </div>
        <div class="rv-evidence">
          <button class="btn-evidence" type="button" data-action="candidate-evidence" data-id="${candidate.id}">${icon("i-lock", "icon--sm")}${esc(
            evidence.id || "—",
          )}</button>
          <span class="rv-sub">${esc(evidence.hash || "")}</span>
          <span class="rv-sub">${esc(evidence.at || "")}</span>
        </div>
        <div class="rv-flags">
          ${
            allowlist.status === "hit"
              ? `<span class="chip chip--locked">${icon("i-lock", "icon--sm")}${esc(allowlist.entry || "")} · ${esc(allowlist.kind || "")}</span>`
              : `<span class="chip chip--muted">${t("app.review.noAllowlist")}</span>`
          }
          <span class="rv-sub">${t("app.review.reputationValue", {
            count: reputation.count || 0,
            bonus: (reputation.bonus || 0).toFixed(2),
          })}</span>
          <span class="rv-sub">${prior.length ? t("app.review.priorValue", { decision: prior[0].decision, when: prior[0].when }) : t("app.review.priorNone")}</span>
        </div>
        ${candidateActions(candidate, true)}
      </article>`;
  }

  function candidateCard(candidate) {
    const title = titleOf(candidate.titleId);
    const engine = engineOf(candidate.engine);
    const level = scoreLevel(candidate.score);
    const locked = candidate.allowlisted;
    const variant = candidate.variant || {};
    const evidence = candidate.evidence || {};

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
            <span class="chip">${esc(variant.value || "")}</span>
            ${locked ? `<span class="chip chip--locked">${icon("i-lock", "icon--sm")}${t("app.review.allowlisted")}</span>` : ""}
          </div>
          <div class="rv-sub">${scoreComponentsLabel(candidate)} · ${esc(evidence.id || "")} · ${esc(evidence.at || "")}</div>
          ${candidateActions(candidate)}
        </div>
        <div class="candidate-score">
          <span class="score-num" data-level="${level}">${candidate.score}%</span>
          <span class="score-track"><span class="score-fill" style="width:${candidate.score}%"></span></span>
          <span class="score-label">${t("app.review.match")}</span>
          <span class="rv-formula">${scoreFormula(candidate)}</span>
        </div>
      </article>`;
  }

  function renderViolations() {
    const filter = state.violationTitleFilter || "all";
    const all = visibleViolations();
    const filtered = filter === "all" ? all : all.filter((violation) => violation.titleId === filter);
    const groups = [];
    filtered.forEach((violation) => {
      let group = groups.find((entry) => entry.titleId === violation.titleId);
      if (!group) {
        group = { titleId: violation.titleId, violations: [] };
        groups.push(group);
      }
      group.violations.push(violation);
    });
    const rows = groups
      .map((group) => {
        const title = titleOf(group.titleId);
        const openCount = group.violations.filter((violation) => violation.state === "open").length;
        return `<div class="v-group">
          <div class="v-group-head">
            <span class="v-group-title">${esc(title ? title.name : t("app.unknownTitle"))}</span>
            <span class="v-group-meta">${t("app.violations.groupMeta", {
              open: openCount,
              total: group.violations.length,
            })}</span>
          </div>
          ${group.violations
            .map((violation) => {
              const picked = selected.has(violation.id);
              const inNotice = Boolean(violation.noticeId);
              const canPick = violation.state === "open" && !inNotice;
              return `
        <div class="violation ${violation.state === "removed" ? "is-removed" : ""} ${picked ? "is-picked" : ""}">
          <input class="check" type="checkbox" aria-label="${t("app.violations.select", { host: violation.host })}" data-select="${violation.id}" ${
            picked ? "checked" : ""
          } ${canPick ? "" : "disabled"} />
          <div style="min-width:0">
            <div class="v-title">${esc(violation.host)} <span class="v-host-name muted">· ${esc(violation.url)}</span></div>
          </div>
          <div class="v-evidence">
            <button class="btn-evidence" type="button" data-action="evidence" data-id="${violation.id}">${icon("i-lock", "icon--sm")}${esc(violation.evidence.id)}</button>
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
            .join("")}
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
          <select class="select select--sm" id="violation-title-filter" aria-label="${esc(t("app.violations.filter"))}">
            <option value="all" ${filter === "all" ? "selected" : ""}>${t("app.violations.filterAll")}</option>
            ${state.titles
              .map(
                (title) =>
                  `<option value="${esc(title.id)}" ${filter === title.id ? "selected" : ""}>${esc(title.name)}</option>`,
              )
              .join("")}
          </select>
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
    const cards = visibleNotices()
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
              })}</div>
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
          <div class="notice-body">${stepper(notice)}</div>
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
              ${title.kpId ? `<span class="chip chip--blue">${icon("i-film", "icon--sm")}${t("app.kinopoisk.source")} ${esc(
                String(title.kpId),
              )}</span>` : ""}
              ${title.allowlist.length ? `<span class="chip">${t("app.titles.allowlistedCount", { n: title.allowlist.length })}</span>` : ""}
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
          </div>
        </article>`,
      )
      .join("");

    return `
      <section class="page titles-page">
        <header class="page-head">
          <div>
            <p class="eyebrow"><span class="dot"></span>${t("app.titles.eyebrow")} · ${tn("app.common.titles", state.titles.length)}</p>
            <h1 class="page-title">${t("app.titles.title")}</h1>
          </div>
          <button class="btn btn-primary btn-sm" type="button" data-action="kinopoisk-open">${icon("i-plus", "icon--sm")}${t(
            "app.kinopoisk.open",
          )}</button>
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

  function candidateEvidenceModal(candidate) {
    const title = titleOf(candidate.titleId);
    const variant = candidate.variant || {};
    const evidence = candidate.evidence || {};
    const allowlist = candidate.allowlist || { status: "none" };
    const reputation = candidate.reputation || {};
    const prior = candidate.priorDecisions || [];
    openModal(
      t("app.evidence.candidateTitle", { id: evidence.id || "—" }),
      `<dl class="evidence-grid">
        <div class="ev-row"><dt>${t("app.evidence.titleField")}</dt><dd>${esc(title ? title.name : t("app.evidence.unknown"))}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.variant")}</dt><dd>${esc(variant.value || "—")} · ${esc(variant.kind || "")} · ${esc(
          variant.language || "",
        )} · ${esc(variant.script || "")} · ${esc(variant.territory || "")}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.requestedUrl")}</dt><dd>${esc(candidate.url)}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.finalUrl")}</dt><dd>${esc(candidate.finalUrl || candidate.url)}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.host")}</dt><dd>${esc(candidate.host || hostOf(candidate.url))} · ${esc(candidate.domain || "")}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.captured")}</dt><dd>${esc(evidence.at || "")}</dd></div>
        <div class="ev-row"><dt>SHA-256</dt><dd>${esc(evidence.hash || "")}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.score")}</dt><dd>${candidate.score}% · ${esc(scoreFormula(candidate))} · ${esc(
          scoreComponentsLabel(candidate),
        )}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.allowlist")}</dt><dd>${
          allowlist.status === "hit"
            ? `${esc(allowlist.entry || "")} · ${esc(allowlist.kind || "")} · ${esc(allowlist.scope || "")}`
            : t("app.review.noAllowlist")
        }</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.reputation")}</dt><dd>${t("app.review.reputationValue", {
          count: reputation.count || 0,
          bonus: (reputation.bonus || 0).toFixed(2),
        })}</dd></div>
        <div class="ev-row"><dt>${t("app.evidence.prior")}</dt><dd>${
          prior.length
            ? prior.map((item) => `${esc(item.decision)} · ${esc(item.when)}`).join("<br />")
            : t("app.review.priorNone")
        }</dd></div>
      </dl>
      <p class="muted" style="margin:16px 0 0;font-size:11.5px">${t("app.evidence.candidateNote")}</p>`,
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


  /* KinoPoisk import. */
  function kinopoiskResultMarkup(record) {
    const type = t(record.type === "series" ? "app.kinopoisk.type.series" : "app.kinopoisk.type.film");
    const imported = state.titles.some((title) => title.kpId === record.id);
    return `<article class="kp-result">
      <span class="kp-poster" aria-hidden="true">${esc(record.name.charAt(0))}</span>
      <div class="kp-main">
        <div class="kp-name">${esc(record.name)}</div>
        <div class="kp-sub">${esc(record.original)}<span>${t("app.kinopoisk.resultMeta", {
          year: record.year,
          type,
          id: record.id,
        })}</span></div>
      </div>
      <button class="btn ${imported ? "btn-ghost" : "btn-primary"} btn-sm" type="button" data-action="kinopoisk-import" data-kp-id="${esc(
        record.id,
      )}" ${imported ? "disabled" : ""}>${imported ? t("app.kinopoisk.imported") : t("app.kinopoisk.import")}</button>
    </article>`;
  }

  function refreshKinoResults() {
    const input = document.getElementById("kinopoisk-search");
    const results = document.getElementById("kinopoisk-results");
    if (!input || !results) return;
    const query = input.value.trim();
    if (normalizeSearch(query).length < 2) {
      results.innerHTML = `<p class="kp-empty">${t("app.kinopoisk.prompt")}</p>`;
      return;
    }
    const matches = searchKinoPoisk(query);
    results.innerHTML = matches.length
      ? matches.map(({ record }) => kinopoiskResultMarkup(record)).join("")
      : `<p class="kp-empty">${t("app.kinopoisk.empty")}</p>`;
  }

  function kinopoiskModal(query = "") {
    modalSpec = { type: "kinopoisk", query };
    openModal(
      t("app.kinopoisk.title"),
      `<div class="kp-search">
        <label class="settings-field" for="kinopoisk-search">
          <span>${t("app.kinopoisk.searchLabel")}</span>
          <input class="settings-input" id="kinopoisk-search" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(
            t("app.kinopoisk.placeholder"),
          )}" />
        </label>
        <p class="kp-note">${t("app.kinopoisk.demoNote")}</p>
      </div>
      <div class="kp-results" id="kinopoisk-results" aria-live="polite"></div>`,
    );
    const input = document.getElementById("kinopoisk-search");
    if (!input) return;
    input.value = query;
    refreshKinoResults();
    requestAnimationFrame(() => input.focus());
  }

  function importKinoPoiskTitle(id) {
    const record = KINOPOISK_CATALOG.find((item) => item.id === id);
    if (!record) return;
    if (state.titles.some((title) => title.kpId === record.id)) {
      toast(t("app.kinopoisk.already"), "amber", "i-film");
      refreshKinoResults();
      return;
    }
    state.titles.push({
      id: uid("t"),
      name: record.name,
      original: record.original,
      year: record.year,
      groupKey: record.groupKey,
      variants: record.variants,
      allowlist: [],
      paused: false,
      glow: record.glow,
      kpId: record.id,
      kpType: record.type,
    });
    state.activity.unshift({
      icon: "film",
      tone: "green",
      textKey: "app.activity.titleImported",
      params: { name: record.name },
      time: { minutes: 0 },
    });
    render();
    refreshKinoResults();
    toast(t("app.kinopoisk.importedToast", { name: record.name }), "green", "i-film");
  }

  /* Actions. */
  function handleReview(id, decision, button) {
    const candidate = state.candidates.find((item) => item.id === id);
    if (!candidate) return;
    const card = button.closest(".candidate, .review-row");
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
    HISTORY.push({
      id: uid("h"),
      titleId: candidate.titleId,
      groupKey: title ? title.groupKey : "app.group.feature",
      engine: candidate.engine,
      recipient: state.cartRecipient,
      detectedDay: CHART_DAYS - 1,
      resolvedDay: null,
      resolution: "closed",
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
    if (state.demoState === "empty") state.demoState = "normal";
    const quota = state.demoState === "quota";
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
        if (quota && engine === "google") return;
        state.engines[engine].last = { minutes: 0 };
      });
      const existing = new Set(state.candidates.map((candidate) => candidate.url));
      const fresh = SCAN_POOL.filter(
        (candidate) => !existing.has(candidate.url) && !(quota && candidate.engine === "google"),
      ).slice(0, 2);
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
        params: { engines: quota ? 2 : 3 },
        countType: "newCandidates",
        count: fresh.length,
        time: { minutes: 0 },
      });
      updateChrome();
      render();
      toast(
        quota
          ? t("app.quota.toast")
          : fresh.length
            ? t("app.scan.finished", { candidates: tn("app.scan.newCandidates", fresh.length) })
            : t("app.scan.none"),
        quota ? "amber" : "blue",
        quota ? "i-gauge" : "i-radar",
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

    if (action === "chart-range") {
      const range = Number(trigger.dataset.range);
      if ([7, 14, 30].includes(range)) {
        state.chartRange = range;
        state.chartSelected = null;
        render();
      }
      return;
    }
    if (action === "chart-metric") {
      const metric = trigger.dataset.metric;
      if (CHART_METRICS.some((item) => item.id === metric)) {
        state.chartMetric = metric;
        state.chartSelected = null;
        render();
      }
      return;
    }
    if (action === "resolved-basis") {
      const basis = trigger.dataset.basis;
      if (basis === "closed" || basis === "removed_closed") {
        state.resolvedBasis = basis;
        state.chartSelected = null;
        render();
      }
      return;
    }
    if (action === "review-density") {
      const density = trigger.dataset.density;
      if (density === "rows" || density === "cards") {
        state.reviewDensity = density;
        render();
      }
      return;
    }
    if (action === "demo-state") {
      const demo = trigger.dataset.state;
      if (DEMO_STATES.includes(demo)) {
        state.demoState = demo;
        state.chartSelected = null;
        updateChrome();
        render();
      }
      return;
    }
    if (action === "allowlist-remove") {
      state.allowlistEntries = state.allowlistEntries.filter((entry) => entry.id !== trigger.dataset.id);
      render();
      toast(t("app.allowlist.removed"), "blue", "i-lock");
      return;
    }
    if (action === "candidate-evidence") {
      const candidate = state.candidates.find((item) => item.id === trigger.dataset.id);
      if (candidate) {
        modalSpec = { type: "candidate", id: candidate.id };
        candidateEvidenceModal(candidate);
      }
      return;
    }
    if (action === "kinopoisk-open") {
      kinopoiskModal("");
      return;
    }
    if (action === "kinopoisk-import") {
      importKinoPoiskTitle(trigger.dataset.kpId);
      return;
    }
    if (action === "chart-select") {
      const index = Number(trigger.dataset.index);
      if (Number.isInteger(index)) {
        state.chartSelected = state.chartSelected === index ? null : index;
        render();
      }
      return;
    }

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
    if (action === "deepseek-brief") generateDeepSeekBrief();
    if (action === "clear-deepseek") {
      clearDeepSeekKey();
      state.deepseekBrief = null;
      state.deepseekBriefMode = null;
      state.deepseekError = null;
      render();
      toast(t("app.deepseek.cleared"), "blue", "i-x");
    }
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

  document.addEventListener("pointerover", (event) => {
    if (!(event.target instanceof Element)) return;
    const hit = event.target.closest(".trend-hit");
    if (!hit || !lastChart) return;
    const inspector = document.getElementById("trend-inspector");
    if (inspector) inspector.innerHTML = chartInspectorHtml(lastChart, Number(hit.dataset.index));
  });

  document.addEventListener("pointerout", (event) => {
    if (!(event.target instanceof Element)) return;
    const chart = event.target.closest(".trend-chart");
    if (!chart) return;
    if (event.relatedTarget instanceof Node && chart.contains(event.relatedTarget)) return;
    const inspector = document.getElementById("trend-inspector");
    if (inspector) inspector.innerHTML = chartInspectorHtml(lastChart, state.chartSelected);
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "allowlist-form") {
      event.preventDefault();
      const form = event.target;
      const kind = form.elements.kind.value;
      const value = form.elements.value.value.trim();
      const scope = form.elements.scope.value;
      const target = form.elements.target.value;
      const territory = form.elements.territory.value.trim();
      if (!value) {
        toast(t("app.allowlist.valueRequired"), "amber", "i-lock");
        return;
      }
      state.allowlistEntries.push({
        id: uid("a"),
        kind,
        value,
        scope,
        target: scope === "rights_holder" ? null : target,
        territory: kind === "licensed_destination" ? territory || "*" : null,
        source: "operator",
      });
      render();
      toast(t("app.allowlist.added", { value }), "green", "i-lock");
      return;
    }
    if (event.target.id !== "deepseek-form") return;
    event.preventDefault();
    const input = document.getElementById("deepseek-key");
    const key = input ? input.value.trim() : "";
    if (!key) {
      toast(t("app.deepseek.keyRequired"), "amber", "i-spark");
      return;
    }
    if (!saveDeepSeekKey(key)) {
      toast(t("app.deepseek.storageError"), "amber", "i-spark");
      return;
    }
    state.deepseekBrief = null;
    state.deepseekBriefMode = null;
    state.deepseekError = null;
    render();
    toast(t("app.deepseek.saved"), "green", "i-check");
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "kinopoisk-search") return;
    if (modalSpec && modalSpec.type === "kinopoisk") modalSpec.query = event.target.value;
    refreshKinoResults();
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
    if (event.target.id === "chart-grouping") {
      const grouping = event.target.value;
      if (CHART_GROUPINGS.some((item) => item.id === grouping)) {
        state.chartGrouping = grouping;
        state.chartSelected = null;
        render();
      }
    }
    if (event.target.id === "violation-title-filter") {
      state.violationTitleFilter = event.target.value;
      render();
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
    if (state.deepseekBrief) {
      state.deepseekBrief = null;
      state.deepseekBriefMode = null;
    }
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
      if (modalSpec.type === "kinopoisk") kinopoiskModal(modalSpec.query || "");
    }
  });

  window.addEventListener("hashchange", () => {
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
  });

  render();
  window.scrollTo(0, 0);
})();
