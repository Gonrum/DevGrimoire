import { ReactNode } from 'react';

interface DetailSectionProps {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function DetailSection({ title, meta, actions, children, className = '' }: DetailSectionProps) {
  return (
    <section className={`border-t border-gray-800 pt-5 ${className}`}>
      {(title || meta || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-medium text-gray-400">{title}</h3>}
            {meta && <p className="mt-0.5 text-xs text-gray-600">{meta}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
