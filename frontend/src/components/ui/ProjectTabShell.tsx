import { ReactNode } from 'react';

interface ProjectTabShellProps {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  children: ReactNode;
}

export default function ProjectTabShell({
  title,
  description,
  count,
  primaryAction,
  secondaryActions,
  children,
}: ProjectTabShellProps) {
  const hasHeader = !!title || !!primaryAction || !!secondaryActions;
  return (
    <div className="space-y-4">
      {hasHeader && (
        <div className="flex flex-col gap-3 border-b border-gray-800/60 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
              {typeof count === 'number' && (
                <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-500">{count}</span>
              )}
            </div>
            {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
          </div>
          {(primaryAction || secondaryActions) && (
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              {secondaryActions}
              {primaryAction}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
