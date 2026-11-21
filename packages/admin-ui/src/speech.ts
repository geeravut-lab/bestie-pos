// The browser's own speech recognition and speech synthesis for the live translator (Chrome / Edge / Android / Safari 14.1+). Bestie records nothing: the
// browser turns speech into text, the text goes through the same translation call as the typed box, and the answer is read aloud by the browser.
type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e?: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => RecognitionLike;

/** The BCP-47 tag the browser wants for each language the translator offers. */
export const SPEECH_TAG: Record<string, string> = {
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
export const speechInSupported = (): boolean => ctor() !== null;
export const speechOutSupported = (): boolean =>
  typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis !== 'undefined' &&
  typeof (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance !==
    'undefined';

/** Listen once in `lang`; resolves with what was heard ('' when nothing). `onStop` gives the caller a way to end listening early. */
export function listenOnce(lang: string, onStop?: (stop: () => void) => void): Promise<string> {
  return new Promise((resolve) => {
    const C = ctor();
    if (!C) return resolve('');
    const r = new C();
    r.lang = SPEECH_TAG[lang] ?? 'en-US';
    r.interimResults = false;
    r.continuous = false;
    r.maxAlternatives = 1;
    let heard = '';
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? '')
        .join(' ')
        .trim()
        .slice(0, 600);
    };
    r.onerror = () => undefined;
    r.onend = () => resolve(heard);
    onStop?.(() => {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    });
    try {
      r.start();
    } catch {
      resolve('');
    }
  });
}

/** Read `text` aloud in `lang` (does nothing where the browser has no speech synthesis). */
export function speak(text: string, lang: string): void {
  if (!speechOutSupported()) return;
  const synth = (
    globalThis as unknown as {
      speechSynthesis: { cancel: () => void; speak: (u: unknown) => void };
    }
  ).speechSynthesis;
  const U = (
    globalThis as unknown as { SpeechSynthesisUtterance: new (t: string) => { lang: string } }
  ).SpeechSynthesisUtterance;
  const u = new U(text);
  u.lang = SPEECH_TAG[lang] ?? 'en-US';
  synth.cancel();
  synth.speak(u);
}
