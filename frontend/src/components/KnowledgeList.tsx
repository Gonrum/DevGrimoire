import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Knowledge } from '../api/client';
import Markdown from './Markdown';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';

export default function KnowledgeList({ entries }: { entries: Knowledge[] }) {
  const { t, i18n } = useTranslation();
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
    return <EmptyState message={t('knowledge.noKnowledge')} />;
  }

  return (
    <div>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              selectedCategory === null
                ? 'bg-violet-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {t('common.all')} ({entries.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedCategory === cat
                  ? 'bg-violet-600 text-white'
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
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('knowledge.noCategory')} ({entries.filter((e) => !e.category).length})
            </button>
          )}
        </div>
      )}
      <div className="space-y-4">
        {(selectedCategory === '__none__' ? entries.filter((e) => !e.category) : filtered).map((e) => (
          <Card key={e._id}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{e.topic}</h3>
                {e.category && (
                  <Badge color="bg-indigo-900/40 text-indigo-300">
                    {e.category}
                  </Badge>
                )}
              </div>
              <span className="text-xs text-gray-600">
                {new Date(e.updatedAt).toLocaleDateString(i18n.language === 'de' ? 'de-DE' : 'en-US')}
              </span>
            </div>
            <Markdown className="text-gray-400">{e.content}</Markdown>
            {e.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {e.tags.map((tag) => (
                  <Badge key={tag} color="bg-purple-900/40 text-purple-300">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
