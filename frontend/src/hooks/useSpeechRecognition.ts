import { useState, useEffect, useCallback, useRef } from 'react';

interface SpeechRecognitionEvents {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError: (error: any) => void;
  onEnd: () => void;
}

export function useSpeechRecognition(options: SpeechRecognitionEvents) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setIsSupported(Boolean(SpeechRecognition) && window.isSecureContext);
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('Speech recognition is only available in secure contexts (HTTPS or localhost).');
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || 'de-DE';

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => {
      setIsListening(false);
      options.onEnd();
    };
    recognition.onerror = (event: any) => {
      setError(event.error);
      options.onError(event.error);
      setIsListening(false);
    };
    recognition.onresult = (event: any) => {
      const lastResult = event.results[event.results.length - 1];
      const transcript = lastResult[0].transcript;
      const isFinal = lastResult.isFinal;
      options.onResult(transcript, isFinal);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [isSupported, options]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  return {
    isListening,
    isSupported,
    error,
    startListening,
    stopListening,
  };
}
