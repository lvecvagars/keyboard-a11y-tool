/**
 * Latvian (lv) localization.
 *
 * Single source of truth for all user-facing strings in the frontend
 * (public/index.html) and the HTML report (reports/generator.ts).
 *
 * Terminology follows VARAM (Viedās administrācijas un reģionālās
 * attīstības ministrija) accessibility guidelines. See
 * docs/terminology.md for the full glossary and rationale.
 *
 * Not translated:
 *   - CLI output (src/index.ts) — developer-facing
 *   - Technical progress lines with check IDs (M1-01, M2-03, etc.)
 *   - Code-level identifiers: HTML tags, CSS properties, ARIA roles
 */

import { Severity } from "../types";

export const lv = {
  // ---- App metadata ----
  app: {
    title: "Tastatūras piekļūstamības izvērtētājs",
    subtitle: "Automatizēta tīmekļvietņu novērtēšana atbilstoši WCAG 2.2 — 13 pārbaudes trīs moduļos",
  },

  // ---- Frontend (public/index.html) ----
  frontend: {
    urlLabel: "Tīmekļvietnes adrese izvērtējumam",
    urlPlaceholder: "https://example.com",
    startButton: "Izvērtēt",
    inProgress: "Notiek izvērtēšana...",
    finished: "Izvērtēšana pabeigta",
    errorEmptyUrl: "Lūdzu, ievadiet tīmekļvietnes adresi.",
    starting: (url: string) => `Uzsāk izvērtēšanu: ${url}`,

    // Result card labels
    tabStopsLabel: "TAB punkti",
    issuesLabel: "Atrastās problēmas",
    criticalLabel: "Kritiskas",
    warningLabel: "Brīdinājumi",
    avgScoreLabel: "Vid. vizuālā fokusa vērtējums",
    coverageLabel: "Tastatūras pārklājums",

    openHtmlReport: "Atvērt HTML atskaiti",
    downloadJson: "Lejupielādēt JSON",
  },

  // ---- Progress messages (evaluate.ts) ----
  // Only the non-technical lines are translated. Lines with check IDs
  // and raw numbers stay in English for terminal/log readability.
  progress: {
    launching: "Palaiž pārlūku un atver lapu...",
    capturedScreenshot: "Saglabāts tīmekļvietnes ekrānuzņēmums",
    screenshotFailed: "Brīdinājums: neizdevās saglabāt tīmekļvietnes ekrānuzņēmumu",
    generatingReport: "Ģenerē atskaiti...",
    done: (issues: number, critical: number, seconds: string) =>
      `Pabeigts! Atrastas ${issues} problēmas (no tām ${critical} kritiskas). Ilgums: ${seconds}s`,
  },

  // ---- Error messages (evaluate.ts) ----
  errors: {
    emptyUrl: "Adrese ir tukša",
    invalidUrl: (raw: string) =>
      `Nederīga adrese: "${raw}". Lūdzu, ievadiet derīgu tīmekļa adresi.`,
    nameNotResolved: (url: string) =>
      `Nevar atrast serveri. Pārbaudiet, vai "${url}" ir derīga un sasniedzama adrese.`,
    connectionRefused: (url: string) =>
      `Serveris "${url}" atteica savienojumu. Iespējams, serveris nav pieejams.`,
    certError: (url: string) =>
      `SSL/sertifikāta kļūda adresei "${url}". Vietnei, iespējams, ir nederīgs vai beidzies sertifikāts.`,
    timeout: (url: string) =>
      `Lapas ielāde pārsniedza laika limitu: "${url}". Vietne var būt pārāk lēna vai nepieejama.`,
    loadFailed: (url: string, msg: string) =>
      `Neizdevās ielādēt "${url}": ${msg}`,
    evaluationAlreadyRunning:
      "Izvērtējums jau notiek. Lūdzu, uzgaidiet.",
    missingUrl: "Nav norādīta adrese (lauks 'url' trūkst vai nederīgs)",
    evaluationFailed: (msg: string) => `Izvērtējums neizdevās: ${msg}`,
  },

  // ---- HTML report ----
  report: {
    title: "Tastatūras piekļūstamības atskaite",
    generated: "Izveidota",
    duration: "Ilgums",
    pageScreenshotAlt: (url: string) => `Tīmekļvietnes ${url} ekrānuzņēmums ielādes brīdī`,
    issuesFoundLabel: (n: number) => `Atrastas ${n} problēmas`,
    noIssues: "Nav atrastu tastatūras piekļūstamības problēmu.",
    howToFix: "Kā novērst",
    wcagPrefix: "WCAG",
    entirePage: "Visa lapa",
    footer: "Izveidots ar tastatūras piekļūstamības izvērtēšanas rīku · WCAG 2.2",

    // Severity distribution bar
    severityBar: {
      noIssues: "Nav problēmu",
    },

    // Module summary cards
    modules: {
      m1: {
        name: "TAB taustiņa secība un fokuss",
        metric: "TAB punkti",
        trapCount: (n: number) => `${n} tastatūras slazd${n === 1 ? "s" : "i"}`,
        obscuredCount: (n: number) => `${n} aizsegt${n === 1 ? "s" : "i"} element${n === 1 ? "s" : "i"}`,
      },
      m2: {
        name: "Vizuālā fokusa redzamība",
        metricUnit: "/ 100 vidējais vērtējums",
      },
      m3: {
        name: "Interaktīvo elementu pārklājums",
        metricUnit: "tastatūras pārklājums",
        unreachableCount: (n: number) =>
          `${n} nesasniedzam${n === 1 ? "s" : "i"} element${n === 1 ? "s" : "i"}`,
        nonSemanticCount: (n: number) =>
          `${n} nesemantisk${n === 1 ? "a" : "as"} vadīkl${n === 1 ? "a" : "as"}`,
      },
      allClear: "Viss kārtībā",
    },

    // Screenshot labels
    screenshots: {
      viewportLabel: "Skats, kurā redzams aizsegts fokuss",
      viewportAlt: "Skats, kurā aktīvais elements ir aizsegts ar pārklājumu",
      unfocusedLabel: "Bez fokusa",
      unfocusedAlt: "Elements bez fokusa",
      focusedLabel: "Ar fokusu",
      focusedAlt: "Elements ar fokusu",
      diffLabel: "Atšķirība",
      diffAlt: "Pikseļu atšķirība, kas parāda vizuālo fokusu",
    },
  },

  // ---- Severity labels ----
  // `singular` — used as the severity badge on individual issue cards
  //              (e.g., "Kritiska", "Brīdinājums"). Stands alone, no number.
  // `plural`   — used when the label follows a count
  //              (e.g., "5 kritiskas", "18 brīdinājumi"). Latvian requires
  //              grammatical agreement with numbers.
  severity: {
    critical: "Kritiska",
    warning: "Brīdinājums",
    moderate: "Vidēja",
    info: "Informācija",
  } satisfies Record<Severity, string>,

  severityPlural: {
    critical: "kritiskas",
    warning: "brīdinājumi",
    moderate: "vidējas",
    info: "informācijas",
  } satisfies Record<Severity, string>,

  // ---- Visibility score levels (M2-05) ----
  // Maps the internal level codes to user-facing Latvian labels.
  scoreLevel: {
    none: "nav",
    poor: "slikts",
    partial: "daļējs",
    good: "labs",
    excellent: "izcils",
  } as Record<"none" | "poor" | "partial" | "good" | "excellent", string>,

  // ---- Check names (short labels shown on issue cards) ----
  checkNames: {
    "M1-01": "TAB taustiņa secība",
    "M1-02": "Tastatūras slazds",
    "M1-03": "Fokusa secība",
    "M1-04": "Pārlēciena saite",
    "M1-05": "Aizsegts fokuss",
    "M2-01": "Nav vizuālā fokusa",
    "M2-02": "Noņemta fokusa apmale",
    "M2-03": "Zems kontrasts",
    "M2-04": "Nepietiekams laukums",
    "M2-05": "Fokusa vērtējums",
    "M3-01": "Nav sasniedzams ar tastatūru",
    "M3-02": "Nesemantiska vadīkla",
    "M3-03": "Ritināms apgabals",
  } as Record<string, string>,

  // ---- Issue descriptions (templated) ----
  // These are called with concrete data from the evaluation.
  issues: {
    m101TraversalMismatch: (forward: number, backward: number) =>
      `Pārvietojoties uz priekšu, atrasti ${forward} unikāli TAB punkti, bet atpakaļvirzienā — ${backward}. TAB secība, iespējams, nav pilnībā apgriežama.`,
    m101TraversalFix:
      "Nodrošiniet, lai visi elementi, uz kuriem var pārvietoties ar TAB taustiņu, būtu sasniedzami arī atpakaļvirzienā (Shift+Tab). Pārbaudiet, vai skripti neuztur fokusu tikai vienā virzienā.",

    m102TrapConfirmed: (count: number, elements: string) =>
      `Apstiprināts tastatūras slazds. Fokuss cikliski pārvietojas starp ${count} elementiem (${elements}) bez iespējas izkļūt.`,
    m102TrapSuspected: (location: string, keys: string) =>
      `Aizdomas par tastatūras slazdu pie ${location}, bet izkļūšana bija iespējama ar: ${keys}.`,
    m102TrapFix:
      "Novērsiet tastatūras slazdu. Nodrošiniet, ka lietotāji var pārvietoties prom no jebkura elementa, izmantojot TAB, Shift+Tab vai Escape. Ja modālais logs vai vadīkla tīši ierobežo fokusu, pievienojiet skaidri iezīmētu aizvēršanas mehānismu.",

    m103LowCorrelation: (score: number) =>
      `Fokusa secībai ir zema korelācija ar vizuālo izkārtojumu (Spīrmena ρ = ${score}). TAB secība var mulsināt redzīgus tastatūras lietotājus.`,
    m103LowCorrelationFix:
      "Pārskatiet DOM kārtību, lai tā atbilstu vizuālajai lasīšanas secībai. Izvairieties no CSS pārkārtošanas (flexbox order, grid order), kas atšķiras no avota kārtības. Ja izkārtojumam nepieciešama vizuāla pārkārtošana, pielāgojiet DOM secību.",

    m103PositiveTabindex:
      "Elementam ir tabindex > 0, kas pārraksta dabisko TAB secību un ir plaši zināms anti-paraugs.",
    m103PositiveTabindexFix:
      "Noņemiet pozitīvo tabindex vērtību. Izmantojiet tabindex=\"0\", lai padarītu elementu fokusējamu DOM kārtībā, vai pārkārtojiet DOM tā, lai elementi dabiski parādītos vēlamajā secībā.",

    m103BackwardJump: (distance: number, from: string, to: string) =>
      `Fokuss pārlec ${Math.round(distance)}px atpakaļ vertikāli — avota kārtība neatbilst vizuālajam izkārtojumam.`,
    m103BackwardJumpFix:
      "Pārskatiet šo elementu DOM kārtību. Liels atpakaļlēciens norāda, ka avota kārtība neatbilst vizuālajam izkārtojumam.",

    m104Missing:
      "Pārlēciena saite nav atrasta. Tastatūras lietotājiem jāpārvietojas cauri visiem navigācijas elementiem, lai sasniegtu galveno saturu.",
    m104MissingFix:
      "Pievienojiet pārlēciena saiti kā pirmo fokusējamo elementu lapā. Izmantojiet <a href=\"#main-content\">Pāriet uz galveno saturu</a> un pārliecinieties, ka mērķa elementam ir id=\"main-content\" un tas ir fokusējams (pievienojiet tabindex=\"-1\", ja nepieciešams).",

    m104Unreachable: (target: string) =>
      `Pārlēciena saite atrasta, bet tās mērķis (${target}) nav sasniedzams — aktivizējot saiti, fokuss netika pārvietots uz mērķa elementu.`,
    m104UnreachableFix:
      "Pārliecinieties, ka pārlēciena saites mērķa elements pastāv, tam ir pareizs id un tas ir fokusējams. Pievienojiet tabindex=\"-1\" mērķa elementam, ja tas nav dabiski fokusējams.",

    m105FullyObscured: (obscurer: string) =>
      `Aktīvais elements ir pilnīgi aizsegts (100%) ar ${obscurer}.`,
    m105FullyObscuredFix:
      "Nodrošiniet, lai aktīvie elementi nebūtu aizsegti aiz fiksētiem vai pielīmētiem elementiem. Izmantojiet scroll-padding-top vai scroll-margin-top, lai kompensētu saturu zem pielīmētiem galvenēm. Aizveriet vai pārvietojiet pārklājumus (sīkdatņu paziņojumus, tērzēšanas logrīkus), ja tie aizsedz aktīvo saturu.",

    m105PartiallyObscured: (percent: number, obscurer: string) =>
      `Aktīvais elements ir ${percent}% aizsegts ar ${obscurer}.`,
    m105PartiallyObscuredFix:
      "Nodrošiniet, lai aktīvie elementi nebūtu daļēji aizsegti aiz fiksētiem vai pielīmētiem elementiem. Izmantojiet scroll-padding vai pielāgojiet izkārtojumu, lai aktīvie elementi paliktu pilnībā redzami.",

    m202OutlineRemoved: (selector: string, source: string) =>
      `CSS noteikums "${selector}" noņem outline pie :focus bez aizvietotāja (avots: ${source}).`,
    m202OutlineRemovedFix:
      "Nenoņemiet noklusēto fokusa outline, ja nepiedāvājat tikpat labi redzamu aizvietotāju. Pievienojiet box-shadow, border vai pielāgotu outline tajā pašā noteikumā.",

    m201NoIndicator: (pixels: number) =>
      `Nav atrasts redzams vizuālais fokuss (${pixels} mainīti pikseļi, slieksnis ir 10).`,
    m201NoIndicatorFix:
      "Pievienojiet redzamu vizuālo fokusu, izmantojot :focus vai :focus-visible. Lietojiet outline, box-shadow vai border, kas kontrastē ar apkārtējo fonu.",

    m202CssOutlineRemoved:
      "Noklusētais outline aktīvi tiek noņemts pie fokusa, un nav pievienota aizvietotāja CSS īpašība.",
    m202CssOutlineRemovedFix:
      "Nenomāciet fokusa outline, nepiedāvājot alternatīvu. Pievienojiet box-shadow, border vai background-color izmaiņas tajā pašā :focus noteikumā.",

    m203LowContrast: (median: number, percent: number) =>
      `Vizuālā fokusa kontrasts ir zem 3:1 (mediāna ${median}:1, ${percent}% pikseļu atbilst slieksnim).`,
    m203LowContrastFix:
      "Palieliniet vizuālā fokusa kontrastu. Izmantojiet krāsu, kas atšķiras gan no elementa fona, gan no lapas fona vismaz par 3:1. Labi darbojas tumši outline uz gaiša fona vai otrādi.",

    m204SmallArea: (qualifying: number, required: number, ratio: number) =>
      `Vizuālā fokusa laukums ir zem WCAG 2.4.13 minimuma (${qualifying}px atbilstošu vs ${required}px nepieciešamu, attiecība ${ratio}).`,
    m204SmallAreaFix:
      "Palieliniet vizuālā fokusa izmēru. Izmantojiet vismaz 2px biezu outline vai border ap visu elementa perimetru. Nodrošiniet, ka fokuss atbilst gan minimālajai laukuma, gan 3:1 kontrasta prasībai.",

    m301Unreachable: (signals: string) =>
      `Interaktīvs elements (${signals}) nav sasniedzams ar tastatūru. Peles lietotāji to var aktivizēt, bet tastatūras lietotāji — nē.`,
    m301UnreachableWithRole: (role: string) =>
      `Šim elementam ir role="${role}", bet tas nav fokusējams. Pievienojiet tabindex="0" un nodrošiniet, ka ir klātesoši tastatūras notikumu apstrādātāji (keydown Enter un Space taustiņiem).`,
    m301UnreachableFix:
      "Padariet šo elementu sasniedzamu ar tastatūru, izmantojot dabisku interaktīvu elementu (<button>, <a href>), vai pievienojiet tabindex=\"0\", atbilstošu ARIA lomu un tastatūras notikumu apstrādātājus.",

    m302NonSemantic: (tag: string, issues: string) =>
      `Nesemantisks <${tag}> elements tiek lietots kā interaktīva vadīkla, bet tam trūkst: ${issues}.`,
    m302NonSemanticFix: (tag: string) =>
      `Aizstājiet šo <${tag}> ar dabisku interaktīvu elementu (<button> vai <a href>). Ja pielāgots elements ir nepieciešams, pievienojiet visus: tabindex="0" (fokusējamība), role="button" vai atbilstošu lomu (semantika), un keydown apstrādātāju Enter un Space taustiņiem (darbināmība).`,

    m303ScrollableInaccessible: (scrollHeight: number, clientHeight: number) =>
      `Ritināms apgabals (${scrollHeight}px satura ${clientHeight}px konteinerā) nav sasniedzams ar tastatūru. Tam nav tabindex un nav fokusējamu bērnelementu.`,
    m303ScrollableInaccessibleFix:
      "Pievienojiet tabindex=\"0\" ritināmajam konteinerim, lai tastatūras lietotāji to varētu fokusēt un ritināt ar bulttaustiņiem. Pievienojiet arī atbilstošu lomu (piem., role=\"region\") un aria-label, kas apraksta saturu.",

    // Non-semantic control issues — returned as separate strings and joined with "; "
    m302Issues: {
      missingTabindex: "trūkst tabindex — nav fokusējams ar tastatūru",
      missingRole: "trūkst ARIA lomas — mērķis netiek paziņots palīgtehnoloģijām",
      missingKeyHandler: "nav keydown/keypress apstrādātāja — nav darbināms ar tastatūru",
    },
  },
} as const;

export type Lv = typeof lv;