import { useState, useEffect } from 'react';
import { api, Manual } from '../api/client';
import Markdown from './Markdown';

export default function ManualView({ projectId }: { projectId: string }) {
  const [manual, setManual] = useState<Manual | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.manuals.get(projectId)
      .then(setManual)
      .catch(() => setManual(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleDownload = () => {
    if (!manual) return;
    const blob = new Blob([manual.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${manual.title || 'Benutzerhandbuch'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <p className="text-gray-500 text-sm">Laden...</p>;

  if (!manual || !manual.content) {
    return <p className="text-gray-500 text-sm">Noch kein Handbuch vorhanden. Der Agent kann eines erstellen.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">{manual.title || 'Benutzerhandbuch'}</h2>
          <p className="text-xs text-gray-500">
            Zuletzt bearbeitet: {new Date(manual.updatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {manual.lastEditedBy && ` von ${manual.lastEditedBy}`}
          </p>
        </div>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Markdown herunterladen
        </button>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
        <Markdown>{manual.content}</Markdown>
      </div>
    </div>
  );
}
