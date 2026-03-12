import { useState } from 'react';
import { api, Manual } from '../api/client';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import { useToast } from './Toast';
import Button from './ui/Button';
import Card from './ui/Card';
import Badge from './ui/Badge';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';

function ManualForm({ projectId, manual, onSaved, onCancel }: {
  projectId: string;
  manual?: Manual;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(manual?.title || '');
  const [content, setContent] = useState(manual?.content || '');
  const [category, setCategory] = useState(manual?.category || '');
  const [sortOrder, setSortOrder] = useState(manual?.sortOrder ?? 0);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      if (manual) {
        await api.manuals.update(manual._id, {
          title: title.trim(),
          content,
          category: category.trim() || undefined,
          sortOrder,
        });
      } else {
        await api.manuals.create({
          projectId,
          title: title.trim(),
          content,
          category: category.trim() || undefined,
          sortOrder,
        });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Titel</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500" autoFocus />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Kategorie</label>
          <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="z.B. Setup, API, Deployment"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
        </div>
        <div className="w-24">
          <label className="block text-xs text-gray-500 mb-1">Sortierung</label>
          <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Inhalt</label>
        <MarkdownEditor value={content} onChange={setContent} rows={12} placeholder="Markdown-Inhalt..." />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? 'Speichern...' : 'Speichern'}
        </Button>
        <Button type="button" onClick={onCancel}>Abbrechen</Button>
      </div>
    </form>
  );
}

function ManualEntry({ manual, onUpdate, onEdit }: {
  manual: Manual;
  onUpdate: () => void;
  onEdit: () => void;
}) {
  const { showError } = useToast();
  const [expanded, setExpanded] = useState(false);

  const handleDownload = () => {
    const blob = new Blob([manual.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${manual.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => setExpanded(!expanded)} className="text-left flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200 hover:text-white transition-colors">
            {manual.title}
          </h3>
          {!expanded && manual.content && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{manual.content.slice(0, 150)}{manual.content.length > 150 ? '...' : ''}</p>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {manual.category && (
            <Badge color="bg-blue-900/50 text-blue-300" rounded="full">{manual.category}</Badge>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          {manual.content ? (
            <Markdown>{manual.content}</Markdown>
          ) : (
            <p className="text-xs text-gray-600 italic">Kein Inhalt</p>
          )}
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
            <Button size="xs" onClick={onEdit}>Bearbeiten</Button>
            <Button size="xs" onClick={handleDownload}>Markdown herunterladen</Button>
            <span className="text-xs text-gray-600 ml-auto">
              {new Date(manual.updatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {manual.lastEditedBy && ` · ${manual.lastEditedBy}`}
            </span>
            <ConfirmButton onConfirm={async () => {
              try {
                await api.manuals.delete(manual._id);
                onUpdate();
              } catch (err: any) {
                showError(err.message || 'Löschen fehlgeschlagen');
              }
            }} />
          </div>
        </div>
      )}
    </Card>
  );
}

export default function ManualView({ projectId, entries, onUpdate }: { projectId: string; entries: Manual[]; onUpdate: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editingManual, setEditingManual] = useState<Manual | undefined>(undefined);

  // Group by category
  const categories = new Map<string, Manual[]>();
  for (const m of entries) {
    const cat = m.category || '';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(m);
  }
  // Sort: uncategorized first, then alphabetical
  const sortedCategories = [...categories.entries()].sort((a, b) => {
    if (!a[0] && b[0]) return -1;
    if (a[0] && !b[0]) return 1;
    return a[0].localeCompare(b[0]);
  });

  if (showForm || editingManual) {
    return (
      <div>
        <h2 className="text-lg font-semibold mb-4">{editingManual ? 'Eintrag bearbeiten' : 'Neuer Handbuch-Eintrag'}</h2>
        <ManualForm
          projectId={projectId}
          manual={editingManual}
          onSaved={() => { setShowForm(false); setEditingManual(undefined); onUpdate(); }}
          onCancel={() => { setShowForm(false); setEditingManual(undefined); }}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Button onClick={() => setShowForm(true)} className="bg-blue-600 hover:bg-blue-500 text-white">
          + Neuer Eintrag
        </Button>
      </div>

      {entries.length === 0 && (
        <EmptyState message="Noch keine Handbuch-Einträge. Lege einen über das Formular oder per MCP an." />
      )}

      {sortedCategories.map(([cat, items]) => (
        <div key={cat || '__none'} className="mb-6">
          {cat && (
            <h3 className="text-sm font-medium text-gray-400 mb-2">{cat}</h3>
          )}
          <div className="space-y-2">
            {items.map((m) => (
              <ManualEntry
                key={m._id}
                manual={m}
                onUpdate={onUpdate}
                onEdit={() => setEditingManual(m)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
