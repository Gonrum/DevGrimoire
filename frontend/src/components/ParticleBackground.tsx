const PARTICLE_COUNT = 40;

interface Particle {
  id: number;
  left: string;
  size: number;
  duration: string;
  delay: string;
  opacity: number;
  color: 'violet' | 'cyan';
}

/**
 * Deterministischer Pseudo-Zufall (mulberry32) aus einem Index.
 *
 * Vorher stand hier `Math.random()` in einem `useMemo`. Das war zweifach
 * unsauber: `react-hooks/purity` verbietet einen unreinen Aufruf im Render, und
 * `useMemo` ist ausdrücklich **keine** Garantie — React darf den Cache
 * verwerfen, dann springen alle 40 Partikel auf einen Schlag an neue Positionen.
 *
 * Aus einem Index gerechnet ist die Verteilung dieselbe, das Ergebnis aber
 * stabil. Damit hängen die Partikel an keinem Hook mehr und werden **einmal**
 * beim Modulladen erzeugt.
 */
function pseudoRandom(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const PARTICLES: Particle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
  const r = (offset: number) => pseudoRandom(i * 8 + offset);
  return {
    id: i,
    left: `${r(0) * 100}%`,
    size: r(1) * 3 + 1,
    duration: `${r(2) * 60 + 60}s`,
    delay: `${r(3) * -80}s`,
    opacity: r(4) * 0.3 + 0.1,
    color: r(5) > 0.5 ? 'violet' : 'cyan',
  };
});

export default function ParticleBackground() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0" aria-hidden="true">
      {PARTICLES.map((p) => (
        <span
          key={p.id}
          className="absolute rounded-full particle-float"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            opacity: p.opacity,
            backgroundColor: p.color === 'violet' ? 'rgb(139, 92, 246)' : 'rgb(34, 211, 238)',
            boxShadow: `0 0 ${p.size * 3}px ${p.color === 'violet' ? 'rgba(139, 92, 246, 0.6)' : 'rgba(34, 211, 238, 0.6)'}`,
            animationDuration: p.duration,
            animationDelay: p.delay,
          }}
        />
      ))}
    </div>
  );
}
