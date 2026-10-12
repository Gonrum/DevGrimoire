import { Types } from 'mongoose';

/**
 * Laufzeit-Guard für die Lösch-Kaskaden `removeByProject`/`removeByCustomer`
 * (M-3).
 *
 * Diese Methoden machen `deleteMany({ projectId })`. Mongoose entfernt
 * `undefined`-Schlüssel aus Filtern (siehe CLAUDE.md) — ein `undefined` als
 * Id wird damit zu `deleteMany({})`, also zur ganzen Collection. Heute sind
 * alle Aufrufer nur zufällig abgesichert (requireString, Truthiness-Check im
 * @OnEvent, ein werfender ObjectId-Konstruktor); jeder neue Aufrufer hätte
 * daraus einen instanzweiten Massenlösch-Vorgang gemacht.
 *
 * Wirft statt still nichts zu tun: ein Kaskaden-Aufruf ohne gültige Id ist
 * immer ein Programmierfehler, der laut auffallen soll.
 */
export function assertSafeCascadeId(id: unknown, field: string): asserts id is string {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id) || !/^[0-9a-f]{24}$/i.test(id)) {
    throw new Error(`Kaskaden-Löschung verweigert: ungültige ${field} (${String(id)})`);
  }
}
