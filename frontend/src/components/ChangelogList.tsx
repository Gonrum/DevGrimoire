import { ChangelogEntry } from '../api/client';

export default function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-gray-500 text-sm">Noch keine Changelog-Einträge. Claude kann welche per MCP anlegen.</p>;
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => (
        <div
          key={e._id}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4"
        >
          <div className="flex items-center gap-3 mb-2">
            {e.version && (
              <span className="text-sm font-mono font-semibold bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded">
                v{e.version}
              </span>
            )}
            {e.component && (
              <span className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded">
                {e.component}
              </span>
            )}
            <span className="text-xs text-gray-600 ml-auto">
              {new Date(e.createdAt).toLocaleDateString('de-DE', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          {e.summary && (
            <p className="text-sm text-gray-300 mb-2">{e.summary}</p>
          )}
          <ul className="text-sm text-gray-400 space-y-1">
            {e.changes.map((change, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-gray-600 shrink-0">•</span>
                <span>{change}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
