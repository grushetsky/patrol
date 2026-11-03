# KinoPoisk Licensing and Lawful Use of Its Data

- **Date:** 2026-11-03
- **Ticket:** [#24 — KinoPoisk licensing and lawful use of its data](https://github.com/grushetsky/patrol/issues/24)
- **Status:** Research complete; the hand-entry route needs no licence if KinoPoisk is not the source of the stored values.
- **Scope:** The KinoPoisk user agreement, Russian copyright and database law, and the conditional Wikidata search dependency. No product code, no architecture, no pricing, no vendor integration.

## Question

The ticket body, verbatim (its leading `## Question` heading is omitted because this section supplies it):

> Patrol acquires no catalogue metadata automatically. Operators enter titles by hand, assisted by a fuzzy search field. Decide what that route may lawfully store and reference.
>
> Constraints settled: no scraping, no vendor API, no bulk import, no licensed feed. KinoPoisk is a browsing reference for the operator, not an integration.
>
> Gather from primary sources:
>
> - The KinoPoisk user agreement clauses on automated access and copying, quoted verbatim with document version, and whether they reach a human operator typing a title, original title, release year, and alias by hand.
> - Whether short titles and factual metadata attract copyright, and what the database-exclusive right under ст. 1334 ГК РФ prohibits for a rights holder manually entering a modest number of titles, quoted from primary legal text.
> - If the fuzzy search field is backed by a remote source, that source's licence, rate limits, and agent identification, plus whether storing a hand-picked result is lawful.
>
> Acceptance: what a hand-entry-only route may store and reference, with the licence question answered or explicitly answered as "none required"; each claim traced to its source; remaining product decisions named as such rather than researched.

## Method and scope notes

Claims are traced to the document that owns them: the KinoPoisk user agreement, the Civil Code articles, and the Wikimedia documentation. Legal quotations are reproduced in the original Russian, with a short working gloss where the wording matters. Application of a rule to Patrol's facts is marked `[INFERENCE]` and the reasoning is given.

Two access constraints shaped the note and are disclosed in the appendix. First, `kinopoisk.ru` redirects unauthenticated requests to Yandex SSO, so pages could not be read live. Second, `yandex.ru/legal/kinopoisk_termsofuse/` served a captcha from this network, so the agreement was read from the latest Internet Archive snapshot that returned the document; the snapshot is dated 2025-04-02 and carries the publication date 08.09.2022. A later amendment cannot be excluded from that evidence.

KinoPoisk is treated here as a browsing reference only, per the ticket's settled constraint. Whether the site's content is technically reachable is irrelevant to the legal reading.

## Findings

### 1. The KinoPoisk user agreement and whom it binds

**Document and version.** The agreement is the «Пользовательское соглашение сайта «Кинопоиск»», published at `https://yandex.ru/legal/kinopoisk_termsofuse` by ООО «Кинопоиск», which the document defines as the site administration and the owner of the exclusive rights in the site [1]. The archived copy records «Дата публикации 08.09.2022 г.» and lists only earlier versions, so 08.09.2022 is the current version in that copy [2].

**What counts as covered information.** The agreement defines the object of its restrictions broadly:

> «Информация — информация, размещаемая (размещенная) Пользователем или Администрацией Сайта на Сайте, в том числе: Персональная информация Пользователя, ссылки на другие сайты, любые текстовые сообщения, рецензии на фильмы (Пользовательские рецензии), фотографии (изображения), аудио- и/или видео-произведения, компьютерные программы, Рейтинг Кинопоиска и др. файлы.»

> «База данных — совокупность Информации, размещаемой (размещенной) на Сайте. Вся Информация, размещенная на Сайте, а также подбор, группировка и расположение Информации, является интеллектуальной собственностью Администрации Сайта и (или) иных правообладателей.»

A title, original title, release year, or alias displayed on the site therefore falls inside the agreement's definition of «Информация», even though it is a fact rather than an expressive work. The agreement binds visitors without an account, because access itself constitutes acceptance: «Доступ к Сайту, использование Сайта и/или совершение любых иных действий на Сайте Пользователем означает, что Пользователь принимает и обязуется соблюдать все условия настоящего Соглашения» [1].

**Automated access.** Clause 5.2 contains the prohibition on collection:

> «не распространять и/или не использовать какие-либо компьютерные программы, роботы («пауки») или другие автоматические алгоритмы и методы, направленные на «выкачивание» (сбор), незаконную передачу, копирование, блокирование, модификацию, уничтожение Информации и Базы данных, а также направленные на обход ограничений, установленных Администрацией Сайта в настройках Сайта» [1].

The subject of the prohibition is programs, robots («spiders»), and other automatic algorithms and methods. A person reading a page and typing four fields is not a program or an automatic method, so clause 5.2 does not, on its wording, reach that act. `[INFERENCE]` The clause is aimed at scrapers and bulk collectors, which is also why it pairs collection with circumvention of site restrictions.

**Copying and saving.** Clause 6.6 is wider and is not limited to automated means:

> «Пользователь или иные третьи лица не имеют права (если только иное прямо не разрешено сервисами Сайта) каким-либо образом изменять, копировать, стирать, сохранять, выкачивать, распространять, передавать, продавать, «постить» и иным образом использовать Информацию, размещенную на Сайте (за исключением той Информации, которая была законно размещена на Сайте самим Пользователем) без предварительного разрешения Администрации Сайта и/или соответствующего правообладателя, кроме случаев, когда Администрация Сайта и/или правообладатель явным образом выразили свое согласие на свободное использование Информации любым лицом» [1].

The verbs «копировать» and «сохранять» are unqualified as to method, so a literal reading covers writing a displayed value into another system by hand. The clause's evident purpose is to prevent copying site content, and a single factual field is not a copy of the site's content, but the text does not carve manual transcription out. The only carve-outs are permission from the administration or the rights holder, and information the user lawfully posted itself.

**Purpose limitation.** Clause 6.7 is the decisive clause for a commercial operator, because it restricts purpose rather than method:

> «Пользователи обязуются использовать Информацию, а также любую иную информацию, содержащуюся на Сайте только в личных некоммерческих целях, за исключением случаев, когда разрешение на иное использование дано Администрацией Сайта и/или соответствующими правообладателями» [1].

This clause does not distinguish automated from manual use. `[INFERENCE]` Using a title or year read on the site to populate a commercial rights-enforcement service is use for a non-personal, commercial purpose, and it is permitted only with the administration's or the rights holder's permission. The clause itself names «соответствующими правообладателями» as potential grantors, so the rights holder can authorise use of its own works; a rights holder policing third-party works cannot authorise use of those works.

**Answer to the ticket's question.** The automated-access clause (5.2) does not reach a human operator typing by hand. The copying clause (6.6) is broad enough to be argued to reach it, and the purpose clause (6.7) plainly reaches commercial use of what was read, whatever the input method. The agreement therefore does not make KinoPoisk a lawful browsing reference for a commercial service absent permission, even though it does not prohibit the physical act of typing.

### 2. Copyright in short titles and factual metadata

**Works and titles.** Article 1259 protects works of literature and art, and extends copyright to a title only conditionally:

> «1. Объектами авторских прав являются произведения науки, литературы и искусства независимо от достоинств и назначения произведения, а также от способа его выражения: литературные произведения; … другие произведения.»

> «7. Авторские права распространяются на часть произведения, на его название, на персонаж произведения, если по своему характеру они могут быть признаны самостоятельным результатом творческого труда автора и отвечают требованиям, установленным пунктом 3 настоящей статьи» [3].

A title is thus protected only when it is itself an independent result of creative work and is expressed in an objective form. `[INFERENCE]` Ordinary film and series titles — «Бойцовский клуб», «Fight Club», «Слово пацана» — are short designations that identify a work rather than express creative content, so on the article's own test they do not qualify. An unusually original title could qualify, so the rule is not that titles are never protected; it is that protection is exceptional and must be established for the specific title.

**Facts.** Two provisions keep factual metadata outside copyright:

> «5. Авторские права не распространяются на идеи, концепции, принципы, методы, процессы, системы, способы, решения технических, организационных или иных задач, открытия, факты, языки программирования, геологическую информацию о недрах.»

> «6. Не являются объектами авторских прав: … 4) сообщения о событиях и фактах, имеющие исключительно информационный характер (сообщения о новостях дня, программы телепередач, расписания движения транспортных средств и тому подобное)» [3].

A release year, a media kind (film or series), and an identifier are facts of this kind. `[INFERENCE]` An alias is a title variant, so it follows the title analysis: a short alias is a designation, not a protected work.

**Consequence.** Copyright does not prohibit an operator from recording a title, original title, release year, media kind, or alias by hand. The only possible restraint on taking those values from KinoPoisk is the contract analysed in finding 1.

### 3. The database-exclusive right and what it prohibits

**The right.** Article 1334 creates a sui generis right in the database as a whole:

> «1. Изготовителю базы данных, создание которой (включая обработку или представление соответствующих материалов) требует существенных финансовых, материальных, организационных или иных затрат, принадлежит исключительное право извлекать из базы данных материалы и осуществлять их последующее использование в любой форме и любым способом (исключительное право изготовителя базы данных). … При отсутствии доказательств иного базой данных, создание которой требует существенных затрат, признается база данных, содержащая не менее десяти тысяч самостоятельных информационных элементов (материалов), составляющих содержание базы данных (абзац второй пункта 2 статьи 1260).

> Никто не вправе извлекать из базы данных материалы и осуществлять их последующее использование без разрешения правообладателя, кроме случаев, предусмотренных настоящим Кодексом. При этом под извлечением материалов понимается перенос всего содержания базы данных или существенной части составляющих ее материалов на другой информационный носитель с использованием любых технических средств и в любой форме» [4].

The prohibited act is extraction of the whole database or a substantial part of its materials, followed by use. The right is independent of copyright in the individual elements, and a database of at least 10,000 independent elements is presumed to have required substantial investment. `[INFERENCE]` KinoPoisk's catalogue plainly exceeds that threshold, so the database is protected; the individual title or year is not.

**What remains permitted.** Article 1335.1 defines the lawful space, including for commercial users:

> «1. Лицо, правомерно пользующееся обнародованной базой данных, вправе без разрешения обладателя исключительного права - изготовителя базы данных и в той мере, в которой такие действия не нарушают авторские права изготовителя базы данных и других лиц, извлекать из базы данных материалы и осуществлять их последующее использование:
> в целях, для которых база данных ему предоставлена, в любом объеме, если иное не предусмотрено договором;
> в личных, научных, образовательных целях в объеме, оправданном указанными целями;
> в иных целях в объеме, составляющем несущественную часть базы данных.

> Использование материалов, извлеченных из базы данных, способом, предполагающим получение к ним доступа неограниченного круга лиц, должно сопровождаться указанием на базу данных, из которой эти материалы извлечены.

[Paragraph 2, on good-faith belief that the right had expired, is omitted.]

> 3. Не допускается неоднократное извлечение или использование материалов, составляющих несущественную часть базы данных, если такие действия противоречат нормальному использованию базы данных и ущемляют необоснованным образом законные интересы изготовителя базы данных.

> 4. Изготовитель базы данных не может запрещать использование отдельных материалов, хотя и содержащихся в базе данных, но правомерно полученных использующим их лицом из иных, чем эта база данных, источников» [5].

**Application to manual entry.** For the rights holder's own works, the operator enters the rights holder's own data and no third-party database right is engaged. For works the rights holder polices, the entry is an insignificant part of KinoPoisk's database, which the statute permits; the question is volume and pattern, not the act of typing. Three consequences follow.

- A modest number of hand-entered titles is extraction of an insignificant part, which the third branch of article 1335.1(1) permits «в иных целях», including commercial ones. The statute contains no numeric threshold for «несущественная часть», so the answer depends on volume and pattern rather than on a formula. `[INFERENCE]` Tens of titles entered for individual matters are far from a substantial part of a catalogue of hundreds of thousands of works.
- Systematic hand-building of a catalogue from KinoPoisk is a different act. Repeated extraction of insignificant parts is prohibited by article 1335.1(3) where it conflicts with normal use of the database and unreasonably prejudices the maker. `[INFERENCE]` A workflow that asks operators to key in every title they encounter would be exactly that pattern, even though each individual entry is small.
- Article 1335.1(4) confirms that KinoPoisk cannot restrict use of individual facts that Patrol obtained from other sources, such as the rights holder's own title list, a notice, or a CC0 source. That is the statutory basis for the operator-authored baseline.

The first branch of article 1335.1(1), use «в целях, для которых база данных ему предоставлена», is expressly subject to a contract («если иное не предусмотрено договором»); the insignificant-part branch is not. `[INFERENCE]` That asymmetry is why the database right does not block a modest manual entry, and why clause 6.7 is analysed separately as a contract claim rather than as an intellectual-property claim. The opening phrase of the article does require the user to be «правомерно пользующееся» the database, so a breach of the site terms could be argued to remove the statutory permission; that argument reinforces, rather than weakens, the advice to keep KinoPoisk out of the workflow.

**Attribution.** Article 1335.1(1) requires a reference to the source database only when the extracted materials are made available to an unlimited circle. `[INFERENCE]` Patrol's single-tenant private tool is not an unlimited circle, so no attribution is triggered by the storage itself; if the catalogue were ever published, the reference would become mandatory.

### 4. What the hand-entry route may lawfully store

The licence question is answered as **none required**, provided the values are not taken from KinoPoisk or another restricted source. The table states the boundary.

| Record | Lawful under hand entry | Basis and caveat |
|---|---|---|
| Title, original title, release year, media kind | Yes | Facts and short designations outside copyright; operator-authored or supplied by the rights holder [3] |
| Aliases and transliterations | Yes, if authored or known independently | Same title analysis; must not be copied as a list from KinoPoisk [3] |
| IMDb ID, KinoPoisk ID, other identifiers | Yes, as facts | Identifiers are facts; a KinoPoisk ID may be read from Wikidata's CC0 statement (P2603) [6][7][11] |
| KinoPoisk rating, description, review text, poster, episode synopsis | No | Expressive content and database materials; copying needs permission [4][5] |
| KinoPoisk page text or snippets | No | Same, and clause 6.6 covers saving Information [1] |
| A title list exported or keyed in bulk from KinoPoisk | No | Substantial or repeated extraction; clauses 5.2 and 6.6, and article 1335.1(3) [1][5] |
| KinoPoisk URL as a reference link | Yes | A URL is a fact and a pointer; storing it is not copying content [3] |
| Provenance fields (`source`, `retrieved_at`, operator) | Yes, and recommended | Needed to show the value did not come from a restricted source; no legal form is prescribed [3] |

A KinoPoisk identifier obtained from Wikidata is lawful for a second reason: the identifier is a fact, and Wikidata's statement of it is CC0, so neither copyright nor the KinoPoisk contract attaches to a person who never visits the site. The table's positive rows depend on the operator not transcribing from the site. If the operator reads the value on KinoPoisk and types it, the copyright and database analysis still permits the modest entry (findings 2 and 3), but clause 6.7 supplies a contract claim that the statute does not. The safe instruction is therefore to source the fields from the rights holder, the notice, or the operator's own knowledge, and to leave KinoPoisk out of the workflow.

### 5. If the fuzzy search field calls Wikidata

This section applies only if the search field is backed by a remote source; a local index triggers none of it. Wikidata's search endpoint is the relevant case, because it is the CC0 source that carries KinoPoisk identifiers.

**What the endpoint does.** `action=wbsearchentities` «Searches for entities using labels and aliases», takes a required `search` string and a required `language`, returns the matched entity's QID, label, and description, and reports the matched term in `aliases` when it differs from the label. `limit` accepts 0–50 with a default of 7; `continue` accepts an offset up to 10,000; `type` defaults to `item` [10]. A live call with `search=Бойцовский клуб&language=ru&uselang=ru` returned `Q190050`, labelled «Бойцовский клуб» and described as «фильм Дэвида Финчера, 1999 год» [12].

**Licence.** Wikidata releases its structured data under CC0:

> «All structured data (i.e. the main, Property, Lexeme, and EntitySchema namespaces) is released into the public domain under Creative Commons Zero» [6].

CC0 is a waiver, not a bare permission. Its legal code lists the rights waived, including «database rights (such as those arising under Directive 96/9/EC …)» and «rights protecting the extraction, dissemination, use and reuse of data in a Work», and then waives them «To the greatest extent permitted by, but not in contravention of, applicable law» [7]. Storing a hand-picked QID, label, or P2603 value is therefore lawful, requires no attribution, and does not carry the KinoPoisk contract, because the value is taken from Wikidata rather than from the KinoPoisk site. `[INFERENCE]` CC0 cannot cure a third party's rights in content that Wikidata itself misappropriated, but an identifier and a title are facts, and no such right is asserted over them.

**Rate limits and identification.** The MediaWiki API guidance states that «There is no hard speed limit on read requests», recommends making «requests in series rather than in parallel», and advises batching multiple items per request where possible; write requests are rate-limited, but a search field performs only reads [8]. The binding requirement is identification: Wikimedia sites require a `User-Agent` header, and scripts must use «an informative User-Agent string with contact information, or they may be blocked without notice». The documented format is `<client name>/<version> (<contact information>) <library/framework name>/<version>`, and generic agents such as `curl` or `Python-urllib` are named as unacceptable [9]. A human-driven search box generates negligible traffic, but the header must still identify Patrol and a contact.

**Storage of a hand-picked result.** Lawful for the same reason as the licence: CC0 waives the rights in Wikidata's data, and the stored record is a QID plus the fields the operator confirmed. Good practice is to store the QID, the retrieval date, and the language of the search, so the record can be re-verified; none of that is a licence condition.

## Conclusion

- **Recommended route.** Operator-authored entries: title, original title, release year, media kind, aliases, and identifiers typed or confirmed by a person. No licence, no fee, and no lead time are required for that route.
- **What may be referenced.** KinoPoisk identifiers may be stored as facts, preferably obtained from Wikidata's CC0 P2603 statements rather than from the site. A KinoPoisk URL may be stored as a pointer.
- **The one legal caveat.** KinoPoisk may not be used as the browsing reference for values that go into a commercial catalogue without the administration's or the rights holder's permission, because clause 6.7 limits use of site information to personal non-commercial purposes. The automated-access clause does not apply to a human, and the database right does not reach a modest manual entry, but the contract does.
- **Cost and lead time.** Zero for the hand-entry route; no contract, fee, or waiting period is involved. Permission to use KinoPoisk as a commercial reference is a business step outside this note.
- **Product decisions, not legal ones.** How many titles per matter is acceptable at v1; whether the operator sees a Wikidata search field or a local alias index; whether the catalogue records provenance fields; whether the tool ever displays a source reference for a database attribution that would be required only on publication.

## References

1. ООО «Кинопоиск», «Пользовательское соглашение сайта «Кинопоиск»», publication date 08.09.2022, clauses 1 (definitions), 5.2, 6.6, 6.7.
   https://yandex.ru/legal/kinopoisk_termsofuse/ (accessed 2026-11-03; live page served a captcha, text read from [2]).
2. Internet Archive snapshot of the same agreement, 2025-04-02.
   https://web.archive.org/web/20250402124707id_/https://yandex.ru/legal/kinopoisk_termsofuse/ (accessed 2026-11-03).
3. Гражданский кодекс Российской Федерации (часть четвертая) от 18.12.2006 № 230-ФЗ, ст. 1259 «Объекты авторских прав», paragraphs 1, 5, 6, 7 (ред. от 23.07.2025, с изм. и доп., вступ. в силу с 04.01.2026).
   https://www.consultant.ru/document/cons_doc_LAW_64629/be05678dc42ddc67aae5be9ba9beebd367fb9a3f/ (accessed 2026-11-03).
4. Гражданский кодекс Российской Федерации (часть четвертая), ст. 1334 «Исключительное право изготовителя базы данных», paragraphs 1–3.
   https://www.consultant.ru/document/cons_doc_LAW_64629/c8b26358cbae2a98f328bd8cb495a08f7e11caff/ (accessed 2026-11-03).
5. Гражданский кодекс Российской Федерации (часть четвертая), ст. 1335.1 «Действия, не являющиеся нарушением исключительного права изготовителя базы данных», paragraphs 1–4.
   https://www.consultant.ru/document/cons_doc_LAW_64629/6a3a364978a1d1c94fdbf7cbf6d14b5c4bb528a1/ (accessed 2026-11-03).
6. Wikidata, «Wikidata:Licensing» (CC0 for structured data in the main, Property, Lexeme, and EntitySchema namespaces).
   https://www.wikidata.org/wiki/Wikidata:Licensing (accessed 2026-11-03).
7. Creative Commons, «CC0 1.0 Universal Legal Code», section 1 (Copyright and Related Rights, including database rights) and section 2 (Waiver).
   https://creativecommons.org/publicdomain/zero/1.0/legalcode.en (accessed 2026-11-03).
8. MediaWiki, «API:Etiquette» (no hard speed limit on read requests; serial requests; batched reads; write requests rate-limited).
   https://www.mediawiki.org/wiki/API:Etiquette (accessed 2026-11-03).
9. Wikimedia Foundation, «Policy:Wikimedia Foundation User-Agent Policy» (informative User-Agent with contact information required; blocking without notice).
   https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy (accessed 2026-11-03).
10. Wikidata, MediaWiki API help for `wbsearchentities` (searches labels and aliases; `limit` 0–50, default 7; `continue` up to 10,000; `type` default `item`).
    https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities (accessed 2026-11-03).
11. Wikidata, Property P2603 «Kinopoisk film ID» / «код фильма на Кинопоиске», described as «identifier for a film/movie in the Russian Kinopoisk.ru database».
    https://www.wikidata.org/wiki/Property:P2603 (accessed 2026-11-03).
12. Wikidata search API, live call `action=wbsearchentities&search=Бойцовский клуб&language=ru`, result `Q190050`.
    https://www.wikidata.org/w/api.php?action=wbsearchentities&search=%D0%91%D0%BE%D0%B9%D1%86%D0%BE%D0%B2%D1%81%D0%BA%D0%B8%D0%B9%20%D0%BA%D0%BB%D1%83%D0%B1&language=ru&uselang=ru&limit=5&format=json (accessed 2026-11-03).

## Appendix: access problems

- **KinoPoisk site.** `https://www.kinopoisk.ru/` redirects unauthenticated requests to `sso.passport.yandex.ru` and then to `sso.kinopoisk.ru`; the page could not be read. No claim in this note depends on live site content, and the URL is cited only as a pointer.
- **KinoPoisk agreement.** `https://yandex.ru/legal/kinopoisk_termsofuse/` returned a Yandex captcha from the research network. The text was read from the latest Internet Archive snapshot that returned HTTP 200, dated 2025-04-02, which carries the publication date 08.09.2022. A version published after April 2025 cannot be excluded; a reader with access to the live page should confirm the publication date and clauses 5.2, 6.6, and 6.7 before relying on this note.
- **Statute text.** The Civil Code articles were read from ConsultantPlus, which reproduces the text with the edition marker «ред. от 23.07.2025» and «вступ. в силу с 04.01.2026». The official publication is on `pravo.gov.ru`; the article text was not cross-checked against it in this session.
- **No unverified price or licence claim remains.** The note contains no pricing, and the licence answer for hand entry is «none required» rather than an estimate.
