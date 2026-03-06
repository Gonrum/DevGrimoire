import { Session } from '../api/client';

export default function SessionList({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) {
    return <p className="text-gray-500 text-sm">Noch keine Sessions aufgezeichnet.</p>;
  }

  return (
    <div className="space-y-4">
      {sessions.map((s) => (
        <div
          key={s._id}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">
              {new Date(s.createdAt).toLocaleString('de-DE')}
            </span>
          </div>
          <p className="text-sm mb-3">{s.summary}</p>

          {s.filesChanged.length > 0 && (
            <div className="mb-2">
              <h4 className="text-xs font-medium text-gray-500 mb-1">
                Geänderte Dateien
              </h4>
              <div className="flex flex-wrap gap-1">
                {s.filesChanged.map((f) => (
                  <code
                    key={f}
                    className="text-xs bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded"
                  >
                    {f}
                  </code>
                ))}
              </div>
            </div>
          )}

          {s.nextSteps.length > 0 && (
            <div className="mb-2">
              <h4 className="text-xs font-medium text-gray-500 mb-1">
                Nächste Schritte
              </h4>
              <ul className="text-sm text-gray-400 list-disc list-inside">
                {s.nextSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ul>
            </div>
          )}

          {s.openQuestions.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-500 mb-1">
                Offene Fragen
              </h4>
              <ul className="text-sm text-yellow-400/80 list-disc list-inside">
                {s.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
