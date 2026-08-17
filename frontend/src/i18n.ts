import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import de from './locales/de.json';
import en from './locales/en.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      de: { translation: de },
      en: { translation: en },
    },
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'devgrimoire_language',
      caches: ['localStorage'],
    },
  })
  .catch((err: unknown) => {
    // Schlägt die Initialisierung fehl, zeigt die Oberfläche nur noch
    // Übersetzungsschlüssel. Das gehört in die Konsole statt still verschluckt.
    console.error('i18n init failed', err);
  });

export default i18n;
