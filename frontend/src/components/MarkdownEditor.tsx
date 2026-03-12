import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from './Markdown';

interface Props {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}

export default function MarkdownEditor({ value, onChange, rows = 5, placeholder, className = '' }: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <button type="button" onClick={() => setPreview(false)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${!preview ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
          {t('common.editMode')}
        </button>
        <button type="button" onClick={() => setPreview(true)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${preview ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
          {t('common.previewMode')}
        </button>
        <span className="text-xs text-gray-600 ml-auto">{t('common.markdown')}</span>
      </div>
      {preview ? (
        <div className={`bg-gray-800 border border-gray-700 rounded px-3 py-2 ${className}`} style={{ minHeight: `${rows * 1.5}rem` }}>
          {value.trim() ? (
            <Markdown className="text-sm text-gray-200">{value}</Markdown>
          ) : (
            <p className="text-sm text-gray-600 italic">{t('common.noPreview')}</p>
          )}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className={`w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-none font-mono ${className}`}
        />
      )}
    </div>
  );
}
