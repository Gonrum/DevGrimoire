import { ResearchEntry } from '../api/client';
import Markdown from './Markdown';

export default function ResearchList({ entries }: { entries: ResearchEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-gray-500 text-sm">Noch keine Recherche-Ergebnisse vorhanden.</p>;
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => (
        <div
          key={e._id}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">{e.title}</h3>
            <span className="text-xs text-gray-600">
              {new Date(e.updatedAt).toLocaleDateString('de-DE')}
            </span>
          </div>
          <Markdown className="text-gray-400">{e.content}</Markdown>
          {e.sources.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-xs text-gray-500 mb-1">Quellen:</p>
              <ul className="space-y-0.5">
                {e.sources.map((src, i) => (
                  <li key={i} className="text-xs text-blue-400 truncate">
                    {src.startsWith('http') ? (
                      <a href={src} target="_blank" rel="noopener noreferrer" className="hover:underline">{src}</a>
                    ) : (
                      src
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {e.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {e.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-teal-900/40 text-teal-300 px-2 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
