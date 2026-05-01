import { ReactNode } from 'react';

interface TabToolbarProps {
  primaryAction?: ReactNode;
  search?: ReactNode;
  filters?: ReactNode;
  viewToggle?: ReactNode;
  secondaryActions?: ReactNode;
  className?: string;
}

export default function TabToolbar({
  primaryAction,
  search,
  filters,
  viewToggle,
  secondaryActions,
  className = '',
}: TabToolbarProps) {
  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center ${className}`}>
      {primaryAction && <div className="shrink-0">{primaryAction}</div>}
      {search && <div className="min-w-0 flex-1 sm:min-w-[12rem]">{search}</div>}
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        {viewToggle}
        {secondaryActions}
      </div>
    </div>
  );
}
