import { ReactNode } from 'react';

interface ListCardHeaderProps {
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function ListCardHeader({
  title,
  badges,
  meta,
  actions,
  className = '',
}: ListCardHeaderProps) {
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
          {badges}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-gray-600">
        {meta}
        {actions}
      </div>
    </div>
  );
}
