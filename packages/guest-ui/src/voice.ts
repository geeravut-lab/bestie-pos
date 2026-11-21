// Voice input for the song search: the browser's own speech recognition (Chrome / Edge / Android / Safari 14.1+). Nothing is recorded or sent by Bestie;
// the browser turns the speech into text which only fills the search box. Where the API is missing the page says so and the typed box stays.
type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => RecognitionLike;

const SPEECH_LANG: Record<string, string> = {
  th: 'th-TH',
  en: 'en-US',
  ru: 'ru-RU',
  he: 'he-IL',
  de: 'de-DE',
  zh: 'zh-CN',
};

function ctor(): RecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = (): boolean => ctor() !== null;

/** Listen once. `onText` gets the recognised words; `onEnd(ok)` is called when listening stops (ok = something was heard). Returns a stop function. */
export function listenOnce(
  lang: string,
  onText: (text: string) => void,
  onEnd: (heard: boolean) => void,
): () => void {
  const C = ctor();
  if (!C) {
    onEnd(false);
    return () => undefined;
  }
  const r = new C();
  r.lang = SPEECH_LANG[lang] ?? 'en-US';
  r.interimResults = false;
  r.maxAlternatives = 1;
  let heard = false;
  r.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript?.trim() ?? '';
    if (text) {
      heard = true;
      onText(text.slice(0, 80));
    }
  };
  r.onerror = () => undefined;
  r.onend = () => onEnd(heard);
  try {
    r.start();
  } catch {
    onEnd(false);
  }
  return () => {
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
  };
}
