/**
 * Conversation routing for Lenny Growth Assistant.
 *
 * Classifies incoming turns into one of three routes:
 * 1. `transcript`: Questions explicitly or implicitly seeking evidence from Lenny's
 *    podcast transcripts (guest names, episodes, podcast mentions, startup growth topics).
 *    `search_transcripts` is enabled.
 * 2. `general`: General conversation (productivity, habits, programming, general knowledge,
 *    jokes, greetings) that should receive a direct model answer without searching transcripts.
 *    Tools are deactivated.
 * 3. `follow_up`: Turns that elaborate on, apply, or reformat advice given in the
 *    immediately preceding conversation turn (e.g. "give me 3 practical examples of applying that advice").
 *    Tools are deactivated so the model reasons over conversation context instead of
 *    triggering ungrounded / cross-guest retrieval.
 */

export type ConversationRoute = "general" | "transcript" | "follow_up";

export interface RouteDecision {
  route: ConversationRoute;
  reason: string;
}

export interface HistoryItem {
  role: "user" | "assistant";
  content: string;
}

/** Known guests in the Lenny transcript corpus (from data/corpus_manifest.json). */
const CORPUS_GUESTS = [
  "amol avasare",
  "brian halligan",
  "elena verna",
  "eric ries",
  "evan spiegel",
  "jason cohen",
  "jason lemkin",
  "jason m lemkin",
  "marc andreessen",
  "mark pincus",
  "nikhyl singhal",
] as const;

/** Distinctive last names or single-name identifiers from the corpus. */
const GUEST_SURNAME_IDENTIFIERS = [
  "avasare",
  "halligan",
  "verna",
  "ries",
  "spiegel",
  "cohen",
  "lemkin",
  "andreessen",
  "pincus",
  "singhal",
] as const;

/** Explicit podcast / transcript keywords. */
const PODCAST_KEYWORDS = [
  "podcast",
  "podcasts",
  "episode",
  "episodes",
  "transcript",
  "transcripts",
  "lenny",
  "lennys",
  "lenny's",
  "rachitsky",
  "show notes",
  "corpus",
  "archive",
  "on the show",
] as const;

/** Phrases asking to compare or find guests / episodes. */
const PODCAST_PATTERNS = [
  /\bwho said\b/i,
  /\bwhich guest\b/i,
  /\bwhat guest\b/i,
  /\bcompare (what )?(two|the|different)? guests\b/i,
  /\bwhat did (the )?guest(s)? say\b/i,
  /\bon the (show|podcast)\b/i,
  /\bin the (show|podcast|transcripts?|archive|corpus)\b/i,
  /\bfrom (the )?podcast\b/i,
  /\b(tell|summarize|explain) (the )?episode\b/i,
  /\bwhat does lenny('s)? (podcast|newsletter)? say\b/i,
  /\b(podcast|episode|show|corpus)\s+interviews?\b/i,
  /\binterviews?\s+(on|from|in)\s+(the\s+)?(podcast|show|corpus)\b/i,
  /\binterview(ed)?\s+by\s+lenny\b/i,
  /\b(podcast|show)\s+guests?\b/i,
  /\bguests?\s+(on|from|in)\s+(the\s+)?(show|podcast)\b/i,
  /\bwho\s+was\s+the\s+guest\b/i,
];

/** General conversation indicators (programming, general productivity, casual, jokes). */
const GENERAL_PROGRAMMING_PATTERNS = [
  /\bjava\b/i,
  /\bpython\b/i,
  /\bc\+\+\b/i,
  /\bgolang\b/i,
  /\brust\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bhtml\b/i,
  /\bcss\b/i,
  /\bsql\b/i,
  /\barray(list)?\b/i,
  /\blinked\s*list\b/i,
  /\bhash\s*map\b/i,
  /\bdata\s*structure(s)?\b/i,
  /\bbig\s*o\b/i,
  /\balgorithm(s)?\b/i,
  /\bfunction(s)?\b/i,
  /\bvariable(s)?\b/i,
  /\brecursion\b/i,
  /\bcompiler\b/i,
  /\bdebug(ging)?\b/i,
  /\bgit (commit|push|pull|branch|rebase)\b/i,
  /\bdocker\b/i,
  /\bkubernetes\b/i,
];

const GENERAL_LIFESTYLE_PATTERNS = [
  /\bprocrastinat(e|ion|ing)\b/i,
  /\bdaily routine\b/i,
  /\bmorning routine\b/i,
  /\bcollege timetable\b/i,
  /\btimetable\b/i,
  /\bstudy (timetable|plan|routine|habits?)\b/i,
  /\btime management\b/i,
  /\bto-do list\b/i,
  /\bpomodoro\b/i,
  /\bstay focused\b/i,
  /\bimprove (my )?(focus|productivity)\b/i,
  /\brushing my work\b/i,
  /\bwithout feeling stressed\b/i,
  /\bmanage stress\b/i,
  /\bworkout routine\b/i,
  /\bsleep (better|hygiene|schedule)\b/i,
  /\bstop procrastinating\b/i,
];

const GENERAL_CASUAL_PATTERNS = [
  /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)[\s!.]*$/i,
  /\btell (me )?a joke\b/i,
  /\bmake me laugh\b/i,
  /\bwrite (me )?a poem\b/i,
  /\bwho are you\b/i,
  /\bwhat can you do\b/i,
  /\bweather today\b/i,
  /\bcapital of\b/i,
  /\btranslate (this|to)\b/i,
];

/** Core growth and startup concepts covered in the podcast corpus. */
const GROWTH_DOMAIN_PATTERNS = [
  /\bproduct[- ]led growth\b/i,
  /\bplg\b/i,
  /\bproduct stops growing\b/i,
  /\bpricing (tier|strategy|power|model|when a product stops growing)\b/i,
  /\bdistribution (channel|moat|advantage)\b/i,
  /\bretention (curve|rate|cohort|analysis)\b/i,
  /\bchurn (benchmarks?|rate|reduction)\b/i,
  /\bcustomer acquisition cost\b/i,
  /\bcac\b/i,
  /\bltv\b/i,
  /\bproduct[- ]market fit\b/i,
  /\bpmf\b/i,
  /\bsales team with 20 ai agents\b/i,
  /\bclaude became the fastest[- ]growing\b/i,
  /\bsequoia ceo coach\b/i,
  /\bwhy half of product managers are in trouble\b/i,
];

/** Follow-up phrasing referencing the previous assistant response. */
const FOLLOW_UP_PATTERNS = [
  /\b(apply|applying) that advice\b/i,
  /\bexamples? of applying that\b/i,
  /\bapply (that|those|this)\b/i,
  /\bapplying (that|those|this)\b/i,
  /\bexamples? of that advice\b/i,
  /\bthat advice\b/i,
  /\bthis advice\b/i,
  /\bthat approach\b/i,
  /\bthose (tips|suggestions|recommendations|points|steps)\b/i,
  /\bturn (that|those|this) into\b/i,
  /\bexplain the (first|second|third|fourth|last) (point|tip|step)\b/i,
  /\bpros and cons of (that|this)\b/i,
  /\bsummarize (that|your answer|those points)\b/i,
  /\bmake a (plan|schedule|timetable) (based on|from) that\b/i,
  /\bmore details on (the )?(first|second|third) (point|step)\b/i,
];

/**
 * Determine the route for a given user prompt and session history.
 */
export function routeTurn(prompt: string, history?: HistoryItem[]): RouteDecision {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // 1. Explicit corpus guest match -> transcript
  for (const guest of CORPUS_GUESTS) {
    if (lower.includes(guest)) {
      return {
        route: "transcript",
        reason: `Prompt explicitly mentions corpus guest "${guest}"`,
      };
    }
  }

  // Check surname identifiers with word boundary to avoid false substrings
  for (const surname of GUEST_SURNAME_IDENTIFIERS) {
    const rx = new RegExp(`\\b${surname}\\b`, "i");
    if (rx.test(lower)) {
      return {
        route: "transcript",
        reason: `Prompt mentions corpus guest surname "${surname}"`,
      };
    }
  }

  // 2. Explicit podcast / transcript keywords or patterns -> transcript
  for (const pattern of PODCAST_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        route: "transcript",
        reason: `Prompt matches podcast query pattern "${pattern}"`,
      };
    }
  }

  for (const kw of PODCAST_KEYWORDS) {
    const rx = new RegExp(`\\b${kw}\\b`, "i");
    if (rx.test(lower)) {
      return {
        route: "transcript",
        reason: `Prompt contains podcast keyword "${kw}"`,
      };
    }
  }

  // 3. Follow-up to preceding conversation (if session history exists)
  const hasHistory = Array.isArray(history) && history.length > 0;
  const lastAssistant = hasHistory
    ? [...history].reverse().find((m) => m.role === "assistant" && m.content?.trim())
    : undefined;

  if (lastAssistant) {
    for (const pattern of FOLLOW_UP_PATTERNS) {
      if (pattern.test(lower)) {
        return {
          route: "follow_up",
          reason: `Prompt references advice from preceding turn ("${pattern}")`,
        };
      }
    }
  }

  // 4. General conversation categories -> general
  for (const pattern of GENERAL_PROGRAMMING_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        route: "general",
        reason: `Prompt matches general programming pattern "${pattern}"`,
      };
    }
  }

  for (const pattern of GENERAL_LIFESTYLE_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        route: "general",
        reason: `Prompt matches general lifestyle/productivity pattern "${pattern}"`,
      };
    }
  }

  for (const pattern of GENERAL_CASUAL_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        route: "general",
        reason: `Prompt matches general casual/chit-chat pattern "${pattern}"`,
      };
    }
  }

  // 5. Check if it explicitly discusses growth/startup domain topics covered in transcripts
  for (const pattern of GROWTH_DOMAIN_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        route: "transcript",
        reason: `Prompt matches core growth domain pattern "${pattern}"`,
      };
    }
  }

  // 6. Default to general conversation
  return {
    route: "general",
    reason: "Prompt does not reference podcast, guests, or specific growth transcript topics",
  };
}
