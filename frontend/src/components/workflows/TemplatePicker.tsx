import { useState, useRef, useEffect } from 'react';
import { Braces } from 'lucide-react';

export interface TemplateOption {
  path: string;
  label: string;
  type?: string;
}

interface Props {
  options: TemplateOption[];
  onPick: (path: string) => void;
}

export function TemplatePicker({ options, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:bg-gray-800 hover:text-cyan-300"
        title="Template-Pfad einfügen"
      >
        <Braces size={16} />
      </button>
      {open && options.length > 0 && (
        <div className="absolute right-0 z-50 mt-1 w-72 max-h-72 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          <ul className="py-1 text-sm">
            {options.map((opt) => (
              <li key={opt.path}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(`{{${opt.path}}}`);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-gray-200 hover:bg-gray-800"
                >
                  <span className="font-mono text-cyan-300">{`{{${opt.path}}}`}</span>
                  <div className="text-xs text-gray-500">{opt.label}{opt.type ? ` · ${opt.type}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && options.length === 0 && (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-gray-700 bg-gray-900 p-3 text-xs text-gray-400 shadow-xl">
          Keine vorgelagerten Nodes verfügbar.
        </div>
      )}
    </div>
  );
}
