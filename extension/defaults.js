// Shared by the service worker, content script, popup and options page.
globalThis.CLAUDELY_DEFAULTS = Object.freeze({
  enabled: true,
  provider: 'codex', // 'claude' | 'codex' | 'opencode'
  claudeConnection: 'auto',
  codexConnection: 'auto',
  opencodeConnection: 'local',
  claudeCheckModel: 'haiku',
  claudeRewriteModel: 'sonnet',
  codexCheckModel: 'gpt-6-luna',
  codexRewriteModel: 'gpt-6-luna',
  opencodeCheckModel: 'openai/gpt-6-luna',
  opencodeRewriteModel: 'openai/gpt-6-luna',
  codexCheckEffort: 'low',
  codexRewriteEffort: 'medium',
  autoCheck: true,
  delayMs: 1200,
  clarity: true,
  checkInputs: false,
  dialect: 'American English',
  styleNotes: '',
  disabledSites: [],
});

globalThis.CLAUDELY_REWRITES = Object.freeze([
  { id: 'fix', label: 'Fix mistakes', instruction: 'Fix every spelling, grammar, and punctuation error (including subject-verb agreement, verb forms and tense, articles, plurals, homophones like their/there, and capitalization) so each sentence is correct. Change nothing else: keep the wording, tone, and meaning.' },
  { id: 'improve', label: 'Improve', instruction: 'Improve clarity, flow, and word choice while keeping the author\'s voice, meaning, and length roughly the same.' },
  { id: 'shorten', label: 'Shorten', instruction: 'Make it more concise. Cut filler and redundancy but keep every key point.' },
  { id: 'formal', label: 'More formal', instruction: 'Make the tone more professional and polished without sounding stiff.' },
  { id: 'friendly', label: 'Friendlier', instruction: 'Make the tone warmer and friendlier while staying natural and sincere.' },
  { id: 'simplify', label: 'Simplify', instruction: 'Use plainer words and shorter sentences so it is easy to read.' },
  { id: 'confident', label: 'Confident', instruction: 'Make it more direct and confident. Remove hedging and unnecessary qualifiers.' },
]);
