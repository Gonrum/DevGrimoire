import { useState, useMemo } from 'react';
import { Knowledge } from '../api/client';
import Markdown from './Markdown';

export default function KnowledgeList({ entries }: { entries: Knowledge[] }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    entries.forEach((e) => { if (e.category) cats.add(e.category); });
    return Array.from(cats).sort();
  }, [entries]);

  const filtered = selectedCategory
    ? entries.filter((e) => e.category === selectedCategory)
    : entries;

  if (entries.length === 0) {
    return <p className="text-gray-500 text-sm">Noch kein Wissen gespeichert.</p>;
  }

  return (
    <div>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              selectedCategory === null
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            Alle ({entries.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedCategory === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {cat} ({entries.filter((e) => e.category === cat).length})
            </button>
          ))}
          {entries.some((e) => !e.category) && (
            <button
              onClick={() => setSelectedCategory('__none__')}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedCategory === '__none__'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              Ohne Kategorie ({entries.filter((e) => !e.category).length})
            </button>
          )}
        </div>
      )}
      <div className="space-y-4">
        {(selectedCategory === '__none__' ? entries.filter((e) => !e.category) : filtered).map((e) => (
          <div
            key={e._id}
            className="bg-gray-900 border border-gray-800 rounded-lg p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{e.topic}</h3>
                {e.category && (
                  <span className="text-xs bg-indigo-900/40 text-indigo-300 px-2 py-0.5 rounded">
                    {e.category}
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-600">
                {new Date(e.updatedAt).toLocaleDateString('de-DE')}
              </span>
            </div>
            <Markdown className="text-gray-400">{e.content}</Markdown>
            {e.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {e.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
