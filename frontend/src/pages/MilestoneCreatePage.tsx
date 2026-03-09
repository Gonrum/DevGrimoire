import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';

export default function MilestoneCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !name.trim()) return;
    setSaving(true);
    try {
      await api.milestones.create({
        projectId: id,
        name: name.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
      });
      navigate(`/projects/${id}?tab=milestones`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      <h1 className="text-xl font-bold mb-6">Neuer Milestone</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-4">
        <FormInput label="Name" required type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Milestone-Name" autoFocus />
        <FormTextarea label="Beschreibung" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Beschreibung (optional)" />
        <FormInput label="Fälligkeitsdatum (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !name.trim()}>
            {saving ? 'Erstellen...' : 'Milestone erstellen'}
          </Button>
          <Button type="button" size="lg" onClick={() => navigate(`/projects/${id}`)}>
            Abbrechen
          </Button>
        </div>
      </form>
    </div>
  );
}
