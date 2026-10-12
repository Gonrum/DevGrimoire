import React from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, Portal } from './Dialog';
import Button from './Button';

interface SpeechConsentDialogProps {
  onConsent: () => void;
  onClose: () => void;
  isOpen: boolean;
}

export const SpeechConsentDialog: React.FC<SpeechConsentDialogProps> = ({ onConsent, onClose, isOpen }) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <Portal>
      <Dialog 
        title={t('notifications.speech.consentTitle')} 
        onClose={onClose}
      >
        <div className="p-4 space-y-4">
          <p className="text-gray-300 text-sm leading-relaxed">
            {t('notifications.speech.consentText')}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('notifications.speech.consentCancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={onConsent}>
              {t('notifications.speech.consentConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Portal>
  );
};
