import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from './Button';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';

interface DictationButtonProps {
  onTextUpdate: (text: string, isFinal: boolean) => void;
}

const MicIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

export const DictationButton: React.FC<DictationButtonProps> = ({ onTextUpdate }) => {
  const { t } = useTranslation();
  const dictationEnabled = localStorage.getItem('dg_dictation_enabled') !== 'false';

  const { isListening, isSupported, startListening, stopListening } = useSpeechRecognition({
    onResult: onTextUpdate,
    onError: () => {},
    onEnd: () => {},
  });

  if (!dictationEnabled) return null;

  if (!isSupported) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled
        title={t('common.speech.notSupported')}
        className="p-2"
      >
        <MicIcon className="w-4 h-4 opacity-50" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant={isListening ? 'danger' : 'secondary'}
      size="sm"
      onClick={() => (isListening ? stopListening() : startListening())}
      className={`p-2 transition-all ${isListening ? 'animate-pulse' : ''}`}
      title={isListening ? t('common.speech.stopDictation') : t('common.speech.dictation')}
    >
      <MicIcon className="w-4 h-4" />
    </Button>
  );
};
