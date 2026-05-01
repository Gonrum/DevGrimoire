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

interface SettingsTabHeaderProps {
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SettingsTabHeader({ description, actions, className = '' }: SettingsTabHeaderProps) {
  if (!description && !actions) return null;
  return (
    <div className={`mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      {description && <p className="text-sm text-gray-400">{description}</p>}
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}

type SettingsSectionTone = 'default' | 'accent' | 'danger';

interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  tone?: SettingsSectionTone;
  children: ReactNode;
  className?: string;
}

const TONE_TITLE_CLASS: Record<SettingsSectionTone, string> = {
  default: 'text-sm font-medium text-gray-300',
  accent: 'text-lg font-semibold text-cyan-400',
  danger: 'text-lg font-semibold text-red-400',
};

const TONE_BORDER_CLASS: Record<SettingsSectionTone, string> = {
  default: 'border-gray-800 bg-gray-900/50',
  accent: 'border-gray-800 bg-gray-900/50',
  danger: 'border-red-900/40 bg-red-950/20',
};

export function SettingsSection({ title, description, meta, tone = 'default', children, className = '' }: SettingsSectionProps) {
  return (
    <section className={`rounded-lg border p-4 ${TONE_BORDER_CLASS[tone]} ${className}`}>
      {(title || description || meta) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className={TONE_TITLE_CLASS[tone]}>{title}</h2>}
            {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
          </div>
          {meta && <div className="shrink-0 text-xs text-gray-500">{meta}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

interface SettingsActionsProps {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}

export function SettingsActions({ children, className = '', align = 'start' }: SettingsActionsProps) {
  const alignment = align === 'end' ? 'justify-end' : 'justify-start';
  return (
    <div className={`mt-4 flex flex-wrap items-center gap-2 ${alignment} ${className}`}>
      {children}
    </div>
  );
}
