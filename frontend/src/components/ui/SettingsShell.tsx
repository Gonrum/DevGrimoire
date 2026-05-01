import { ReactNode } from 'react';

interface SettingsTabItem<T extends string> {
  key: T;
  label: ReactNode;
  group?: string;
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
  maxWidth = 'max-w-5xl',
}: SettingsShellProps<T>) {
  const showSidebar = tabs.length > 1 && activeTab !== undefined && onTabChange !== undefined;

  if (!showSidebar) {
    return (
      <div className={`${maxWidth} mx-auto`}>
        <h1 className="mb-4 text-xl font-bold text-white sm:text-2xl">{title}</h1>
        {children}
      </div>
    );
  }

  const groups: { label?: string; items: SettingsTabItem<T>[] }[] = [];
  for (const tab of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.label === tab.group) {
      last.items.push(tab);
    } else {
      groups.push({ label: tab.group, items: [tab] });
    }
  }

  return (
    <div className={`${maxWidth} mx-auto flex gap-8`}>
      <nav className="sticky top-8 hidden w-44 shrink-0 self-start md:block">
        <h1 className="mb-3 text-base font-bold text-white">{title}</h1>
        {groups.map((group, idx) => (
          <div key={idx} className={idx > 0 ? 'mt-4 border-t border-gray-800 pt-3' : ''}>
            {group.label && (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
                {group.label}
              </p>
            )}
            <ul className="space-y-1">
              {group.items.map((tab) => (
                <li key={tab.key}>
                  <button
                    type="button"
                    onClick={() => onTabChange!(tab.key)}
                    className={`w-full rounded px-3 py-1.5 text-left text-sm transition-colors ${
                      activeTab === tab.key
                        ? 'bg-gray-800 font-medium text-cyan-400'
                        : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="fixed bottom-0 left-0 right-0 z-50 flex gap-1 overflow-x-auto border-t border-gray-800 bg-gray-900 px-2 py-1.5 md:hidden">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange!(tab.key)}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-xs transition-colors ${
              activeTab === tab.key
                ? 'bg-gray-800 font-medium text-cyan-400'
                : 'text-gray-500'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 pb-16 md:pb-0">
        <h1 className="mb-4 text-xl font-bold text-white sm:text-2xl md:hidden">{title}</h1>
        {children}
      </div>
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
