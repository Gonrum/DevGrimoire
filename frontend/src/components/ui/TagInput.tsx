import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  showPrimaryHint?: boolean;
  id?: string;
}

export default function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  showPrimaryHint = true,
  id,
}: TagInputProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const inputId = id ?? `tag-input-${reactId}`;
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filteredSuggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    return suggestions
      .filter((s) => !value.includes(s))
      .filter((s) => q === '' || s.toLowerCase().includes(q))
      .slice(0, 8);
  }, [suggestions, input, value]);

  const addTag = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (value.includes(next)) {
      setInput('');
      return;
    }
    onChange([...value, next]);
    setInput('');
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && input === '' && value.length > 0) {
      removeAt(value.length - 1);
    }
  };

  const handleDragStart = (idx: number) => (e: React.DragEvent<HTMLSpanElement>) => {
    dragIndex.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (idx: number) => (e: React.DragEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const from = dragIndex.current;
    if (from === null || from === idx) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    dragIndex.current = idx;
    onChange(next);
  };

  const handleDragEnd = () => {
    dragIndex.current = null;
  };

  return (
    <div className="space-y-1.5">
      <div
        className="flex flex-wrap items-center gap-1.5 bg-gray-900 border border-gray-800 rounded-lg px-2 py-2 focus-within:border-violet-500 transition-colors min-h-[42px]"
        onClick={() => {
          const el = document.getElementById(inputId);
          el?.focus();
        }}
      >
        {value.map((tag, idx) => (
          <span
            key={`${tag}-${idx}`}
            draggable
            onDragStart={handleDragStart(idx)}
            onDragOver={handleDragOver(idx)}
            onDragEnd={handleDragEnd}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-grab active:cursor-grabbing select-none ${
              idx === 0
                ? 'bg-violet-900/60 text-violet-200 ring-1 ring-violet-500/40'
                : 'bg-gray-800 text-gray-300'
            }`}
            title={idx === 0 && showPrimaryHint ? t('tagInput.primaryHint') : tag}
          >
            <span>{tag}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeAt(idx);
              }}
              className="text-gray-500 hover:text-gray-200 leading-none"
              aria-label={t('tagInput.remove', { tag })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setFocused(false), 120);
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
        />
      </div>
      {focused && filteredSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(s);
              }}
              className="text-xs px-2 py-0.5 rounded-full bg-gray-800 hover:bg-violet-900/60 text-gray-300 hover:text-violet-200 transition-colors"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
      {showPrimaryHint && value.length > 0 && (
        <p className="text-xs text-gray-600">{t('tagInput.primaryHint')}</p>
      )}
    </div>
  );
}
