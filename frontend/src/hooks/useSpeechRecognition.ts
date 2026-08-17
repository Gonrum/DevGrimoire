import { useState, useEffect, useCallback, useRef } from 'react';

/*
 * ---------------------------------------------------------------------------
 * Web-Speech-API-Typen
 * ---------------------------------------------------------------------------
 * `lib.dom.d.ts` (TypeScript 5.9) kennt `SpeechRecognitionResultList`,
 * `SpeechRecognitionResult` und `SpeechRecognitionAlternative` — aber weder
 * `SpeechRecognition` selbst noch seine Events. Die Schnittstelle ist nicht
 * vollständig standardisiert, deshalb fehlt sie in der DOM-Lib.
 *
 * Vorher stand an jeder Zugriffsstelle `(window as any).webkitSpeechRecognition`.
 * Der Unterschied zur Lösung hier ist nicht kosmetisch: eine Assertion behauptet
 * „das ist da und sieht so aus". Die `Window`-Erweiterung unten deklariert die
 * Properties **optional** — der Typ sagt „kann fehlen", und der Code muss den
 * Fall behandeln. Er tut es (`recognitionCtor === null`).
 *
 * Deklariert ist nur, was dieser Hook benutzt. Der Rest der Spec (`grammars`,
 * `maxAlternatives`, `abort()`, `onaudiostart`, `onspeechend`, …) fehlt
 * absichtlich: was nicht behauptet wird, kann auch nicht falsch behauptet sein.
 */

/** Nur `error` wird gelesen; `message` ist in der Spec dabei, aber optional. */
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

/** `results` ist der einzige Teil des Result-Events, der hier gebraucht wird. */
interface SpeechRecognitionEventLike {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    /** Standardname — Safari 14.1+, Chrome 33+ hinter dem Prefix. */
    SpeechRecognition?: SpeechRecognitionCtor;
    /** Chromium/WebKit-Prefix. Beide können fehlen (Firefox). */
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

/**
 * Der Konstruktor, sofern der Browser ihn hat — einmal beim Modul-Laden
 * aufgelöst, denn welche Speech-API vorhanden ist, wechselt zur Laufzeit nicht.
 *
 * `typeof window === 'undefined'` deckt Nicht-Browser-Kontexte ab (Node-Test,
 * SSR-Prerender), damit der Import dort nicht sofort abstürzt.
 */
const recognitionCtor: SpeechRecognitionCtor | null =
  typeof window === 'undefined'
    ? null
    : (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null);

/**
 * Abgeleitet statt gespeichert. Vorher hing dieser Wert in `useState` und wurde
 * aus einem Mount-Effekt gesetzt (`react-hooks/set-state-in-effect`) — für einen
 * Wert, der sich nach dem Laden der Seite nie mehr ändert. Ein zusätzlicher
 * Render pro Hook-Instanz, ohne Gegenwert.
 *
 * `isSecureContext` gehört mit in die Bedingung: über HTTP existiert der
 * Konstruktor in Chrome, `start()` schlägt dann aber fehl.
 */
const speechSupported: boolean =
  recognitionCtor !== null && typeof window !== 'undefined' && window.isSecureContext;

interface SpeechRecognitionEvents {
  onResult: (transcript: string, isFinal: boolean) => void;
  /**
   * Der `error`-Code des Events (`'no-speech'`, `'not-allowed'`, `'network'`, …).
   * Vorher `any`; die Spec garantiert hier einen String.
   */
  onError: (error: string) => void;
  onEnd: () => void;
}

export function useSpeechRecognition(options: SpeechRecognitionEvents) {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  /*
   * Die Handler liegen in einem Ref, damit `startListening` über Renders hinweg
   * stabil bleibt. `options` ist bei jedem Aufrufer ein frisches Objekt-Literal
   * (`useSpeechRecognition({ onResult: …, onError: … })`) und hätte als
   * Dependency die Callback-Identität in jedem Render gewechselt — genau das
   * Muster, mit dem eine vollständige Dep-Liste zur Schleife wird.
   *
   * Geschrieben wird im Effekt, nicht im Render (`react-hooks/refs`). Die
   * Handler werden ausschliesslich aus Speech-Callbacks nach `start()`
   * gerufen, also lange nach dem ersten Commit.
   */
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  /*
   * Kein `async`: die Funktion hatte nichts zu `await`en (`require-await`), ihr
   * `Promise` bleibt aber Teil des Vertrags. `DictationButton` hängt ein
   * `.catch()` daran, weil `recognition.start()` synchron wirft — etwa
   * `InvalidStateError`, wenn schon eine Erkennung läuft. In einer
   * `async`-Funktion wurde dieser Sync-Throw stillschweigend zur Rejection;
   * hier steht die Umwandlung explizit da.
   */
  const startListening = useCallback((): Promise<void> => {
    if (!speechSupported || recognitionCtor === null) {
      setError('Speech recognition is only available in secure contexts (HTTPS or localhost).');
      return Promise.resolve();
    }

    try {
      const recognition = new recognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = document.documentElement.lang || 'de-DE';

      recognition.onstart = () => setIsListening(true);
      recognition.onend = () => {
        setIsListening(false);
        optionsRef.current.onEnd();
      };
      recognition.onerror = (event) => {
        setError(event.error);
        optionsRef.current.onError(event.error);
        setIsListening(false);
      };
      recognition.onresult = (event) => {
        const { results } = event;
        /*
         * `SpeechRecognitionResultList` hat eine Index-Signatur, und die
         * tsconfig fährt ohne `noUncheckedIndexedAccess` — der Typ verspricht
         * hier also einen Wert, den es bei `length === 0` nicht gibt. Vorher
         * war das durch `any` verdeckt. Beide Prüfungen sind Laufzeitschutz,
         * nicht Typkosmetik.
         */
        const lastResult = results[results.length - 1];
        if (!lastResult) return;
        const alternative = lastResult[0];
        if (!alternative) return;
        optionsRef.current.onResult(alternative.transcript, lastResult.isFinal);
      };

      recognitionRef.current = recognition;
      recognition.start();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return {
    isListening,
    isSupported: speechSupported,
    error,
    startListening,
    stopListening,
  };
}
