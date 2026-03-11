import { useState, useMemo } from 'react';
import { SchemaObject, SchemaVersion, DbType, api } from '../api/client';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';

const dbTypeColors: Record<DbType, string> = {
  mssql: 'bg-red-900/40 text-red-300',
  mysql: 'bg-orange-900/40 text-orange-300',
  mongodb: 'bg-green-900/40 text-green-300',
  postgresql: 'bg-blue-900/40 text-blue-300',
};

const dbTypeLabels: Record<DbType, string> = {
  mssql: 'MSSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  postgresql: 'PostgreSQL',
};

export default function SchemaList({ entries }: { entries: SchemaObject[] }) {
  const [selectedDbType, setSelectedDbType] = useState<DbType | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, SchemaVersion[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<string | null>(null);

  const dbTypes = useMemo(() => {
    const types = new Set<DbType>();
    entries.forEach((e) => types.add(e.dbType));
    return Array.from(types).sort();
  }, [entries]);

  const filtered = selectedDbType
    ? entries.filter((e) => e.dbType === selectedDbType)
    : entries;

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!versions[id]) {
      setLoadingVersions(id);
      try {
        const v = await api.schemas.versions(id);
        setVersions((prev) => ({ ...prev, [id]: v }));
      } catch {
        // ignore
      }
      setLoadingVersions(null);
    }
  };

  if (entries.length === 0) {
    return <EmptyState message="Noch keine Schema-Objekte dokumentiert." />;
  }

  return (
    <div>
      {dbTypes.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setSelectedDbType(null)}
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
              selectedDbType === null
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            Alle ({entries.length})
          </button>
          {dbTypes.map((dt) => (
            <button
              key={dt}
              onClick={() => setSelectedDbType(selectedDbType === dt ? null : dt)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedDbType === dt
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {dbTypeLabels[dt]} ({entries.filter((e) => e.dbType === dt).length})
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((schema) => (
          <Card key={schema._id}>
            <div
              className="cursor-pointer"
              onClick={() => toggleExpand(schema._id)}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold font-mono">{schema.name}</h3>
                  <Badge color={dbTypeColors[schema.dbType]}>
                    {dbTypeLabels[schema.dbType]}
                  </Badge>
                  <span className="text-xs text-gray-500">v{schema.version}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>{schema.fields.length} Felder</span>
                  {schema.indexes.length > 0 && (
                    <span>{schema.indexes.length} Indexe</span>
                  )}
                  <span>{new Date(schema.updatedAt).toLocaleDateString('de-DE')}</span>
                  <span className="text-gray-600">{expandedId === schema._id ? '▲' : '▼'}</span>
                </div>
              </div>
              {schema.database && (
                <p className="text-xs text-gray-500 mb-1">DB: {schema.database}</p>
              )}
              {schema.description && (
                <p className="text-xs text-gray-400">{schema.description}</p>
              )}
              {schema.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {schema.tags.map((tag) => (
                    <Badge key={tag} color="bg-purple-900/40 text-purple-300">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {expandedId === schema._id && (
              <div className="mt-4 border-t border-gray-800 pt-4 space-y-4">
                {/* Fields Table */}
                {schema.fields.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">Felder</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500 border-b border-gray-800">
                            <th className="text-left py-1.5 pr-3 font-medium">Name</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Typ</th>
                            <th className="text-center py-1.5 pr-3 font-medium">NULL</th>
                            <th className="text-center py-1.5 pr-3 font-medium">PK</th>
                            <th className="text-center py-1.5 pr-3 font-medium">IDX</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Default</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Referenz</th>
                            <th className="text-left py-1.5 font-medium">Beschreibung</th>
                          </tr>
                        </thead>
                        <tbody>
                          {schema.fields.map((f, i) => (
                            <tr key={i} className="border-b border-gray-800/50">
                              <td className="py-1.5 pr-3 font-mono text-gray-200">{f.name}</td>
                              <td className="py-1.5 pr-3 font-mono text-yellow-400/80">{f.type}</td>
                              <td className="py-1.5 pr-3 text-center">{f.nullable !== false ? '✓' : '—'}</td>
                              <td className="py-1.5 pr-3 text-center">{f.isPrimaryKey ? '🔑' : ''}</td>
                              <td className="py-1.5 pr-3 text-center">{f.isIndexed ? '✓' : ''}</td>
                              <td className="py-1.5 pr-3 text-gray-500 font-mono">{f.defaultValue || ''}</td>
                              <td className="py-1.5 pr-3 text-cyan-400/70 font-mono">{f.reference || ''}</td>
                              <td className="py-1.5 text-gray-500">{f.description || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Indexes Table */}
                {schema.indexes.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">Indexe</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500 border-b border-gray-800">
                            <th className="text-left py-1.5 pr-3 font-medium">Name</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Felder</th>
                            <th className="text-center py-1.5 pr-3 font-medium">Unique</th>
                            <th className="text-left py-1.5 font-medium">Typ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {schema.indexes.map((idx, i) => (
                            <tr key={i} className="border-b border-gray-800/50">
                              <td className="py-1.5 pr-3 font-mono text-gray-200">{idx.name}</td>
                              <td className="py-1.5 pr-3 font-mono text-gray-400">{idx.fields.join(', ')}</td>
                              <td className="py-1.5 pr-3 text-center">{idx.unique ? '✓' : ''}</td>
                              <td className="py-1.5 text-gray-500">{idx.type || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Version History */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">
                    Versionshistorie
                  </h4>
                  {loadingVersions === schema._id ? (
                    <p className="text-xs text-gray-500">Laden...</p>
                  ) : (versions[schema._id] || []).length === 0 ? (
                    <p className="text-xs text-gray-600">Noch keine früheren Versionen.</p>
                  ) : (
                    <div className="space-y-1">
                      {(versions[schema._id] || []).map((v) => (
                        <div
                          key={v._id}
                          className="flex items-center gap-3 text-xs py-1.5 border-b border-gray-800/50"
                        >
                          <span className="font-mono text-gray-300">v{v.version}</span>
                          <span className="text-gray-500">
                            {new Date(v.createdAt).toLocaleString('de-DE')}
                          </span>
                          <span className="text-gray-500">
                            {v.fields.length} Felder, {v.indexes.length} Indexe
                          </span>
                          {v.changeNote && (
                            <span className="text-gray-400 italic">{v.changeNote}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
