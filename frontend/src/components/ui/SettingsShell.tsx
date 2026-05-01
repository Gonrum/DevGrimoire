import { ReactNode } from 'react';

interface SettingsTabItem<T extends string> {
  key: T;
  label: ReactNode;
}

interface SettingsShellProps<T extends string> {
  title: ReactNode;
  tabs?: SettingsTabItem<T>[];
  activeTab?: T;
  onTabChange?: (tab: T) => void;
  children: ReactNode;
  maxWidth?: string;
}

export function SettingsShell<T extends string>({
  title,
  tabs = [],
  activeTab,
  onTabChange,
  children,
  maxWidth = 'max-w-4xl',
}: SettingsShellProps<T>) {
  return (
    <div className={`${maxWidth} mx-auto`}>
      <h1 className="mb-4 text-xl font-bold text-white sm:text-2xl">{title}</h1>
      {tabs.length > 1 && activeTab && onTabChange && (
        <div className="mb-6 overflow-x-auto border-b border-gray-800">
          <div className="flex min-w-max gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onTabChange(tab.key)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'border-cyan-400 text-cyan-400'
                    : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({ title, description, children, className = '' }: SettingsSectionProps) {
  return (
    <section className={`rounded-lg border border-gray-800 bg-gray-900/50 p-4 ${className}`}>
      {(title || description) && (
        <div className="mb-4">
          {title && <h2 className="text-sm font-medium text-gray-300">{title}</h2>}
          {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
