import { useEffect, useState } from 'react';

export type ViewportBreakpoint = 'phone' | 'tablet' | 'desktop';

function classify(width: number): ViewportBreakpoint {
  if (width < 768) return 'phone';
  if (width < 1280) return 'tablet';
  return 'desktop';
}

export function useViewportBreakpoint(): ViewportBreakpoint {
  const [bp, setBp] = useState<ViewportBreakpoint>(
    typeof window !== 'undefined' ? classify(window.innerWidth) : 'desktop',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setBp(classify(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return bp;
}
