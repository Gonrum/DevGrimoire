import { Knowledge } from '../api/client';

export default function KnowledgeList({ entries }: { entries: Knowledge[] }) {
  if (entries.length === 0) {
    return <p className="text-gray-500 text-sm">Noch kein Wissen gespeichert.</p>;
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => (
        <div
          key={e._id}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">{e.topic}</h3>
            <span className="text-xs text-gray-600">
              {new Date(e.updatedAt).toLocaleDateString('de-DE')}
            </span>
          </div>
          <p className="text-sm text-gray-400 whitespace-pre-wrap">{e.content}</p>
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
  );
}
