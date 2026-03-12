import { useMemo } from 'react';

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

export default function ParticleBackground() {
  const particles = useMemo<Particle[]>(() =>
    Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      size: Math.random() * 3 + 1,
      duration: `${Math.random() * 60 + 60}s`,
      delay: `${Math.random() * -80}s`,
      opacity: Math.random() * 0.3 + 0.1,
      color: Math.random() > 0.5 ? 'violet' : 'cyan',
    })),
  []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0" aria-hidden="true">
      {particles.map((p) => (
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
