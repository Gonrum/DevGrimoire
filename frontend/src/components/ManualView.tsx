import { useState } from 'react';
import { api, Manual } from '../api/client';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import { useToast } from './Toast';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';

function ManualForm({ projectId, manual, categories, onSaved, onCancel }: {
  projectId: string;
  manual?: Manual;
  categories: string[];
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
            list="manual-categories"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          <datalist id="manual-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
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

function ManualArticle({ manual, onUpdate, onEdit }: {
  manual: Manual;
  onUpdate: () => void;
  onEdit: () => void;
}) {
  const { showError } = useToast();

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
    <article>
      <div className="prose prose-invert max-w-none">
        {manual.content ? (
          <Markdown>{manual.content}</Markdown>
        ) : (
          <p className="text-sm text-gray-600 italic">Kein Inhalt</p>
        )}
      </div>
      <div className="flex items-center gap-2 mt-6 pt-4 border-t border-gray-800">
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
    </article>
  );
}

export default function ManualView({ projectId, entries, onUpdate }: { projectId: string; entries: Manual[]; onUpdate: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editingManual, setEditingManual] = useState<Manual | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Group by category
  const categoryMap = new Map<string, Manual[]>();
  for (const m of entries) {
    const cat = m.category || '';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(m);
  }
  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    if (!a[0] && b[0]) return -1;
    if (a[0] && !b[0]) return 1;
    return a[0].localeCompare(b[0]);
  });

  const allCategories = sortedCategories.map(([cat]) => cat).filter(Boolean);

  // Auto-select first entry if none selected
  const selected = entries.find((m) => m._id === selectedId) || entries[0] || null;

  if (showForm || editingManual) {
    return (
      <div>
        <h2 className="text-lg font-semibold mb-4">{editingManual ? 'Eintrag bearbeiten' : 'Neuer Handbuch-Eintrag'}</h2>
        <ManualForm
          projectId={projectId}
          manual={editingManual}
          categories={allCategories}
          onSaved={() => { setShowForm(false); setEditingManual(undefined); onUpdate(); }}
          onCancel={() => { setShowForm(false); setEditingManual(undefined); }}
        />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div>
        <div className="mb-4">
          <button type="button" onClick={() => setShowForm(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
            + Neuer Eintrag
          </button>
        </div>
        <EmptyState message="Noch keine Handbuch-Einträge. Lege einen über das Formular oder per MCP an." />
      </div>
    );
  }

  return (
    <div className="flex gap-6 min-h-[400px]">
      {/* Sidebar */}
      <nav className="w-52 shrink-0">
        <div className="sticky top-4 space-y-1">
          <button type="button" onClick={() => setShowForm(true)}
            className="w-full px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors mb-3">
            + Neuer Eintrag
          </button>
          {sortedCategories.map(([cat, items]) => (
            <div key={cat || '__none'}>
              {cat && (
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-3 mb-1 px-2">{cat}</div>
              )}
              {items.map((m) => (
                <button
                  key={m._id}
                  type="button"
                  onClick={() => setSelectedId(m._id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm truncate transition-colors ${
                    selected?._id === m._id
                      ? 'bg-blue-600/20 text-blue-300'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                  }`}
                  title={m.title}
                >
                  {m.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {selected && (
          <ManualArticle
            key={selected._id}
            manual={selected}
            onUpdate={onUpdate}
            onEdit={() => setEditingManual(selected)}
          />
        )}
      </div>
    </div>
  );
}
