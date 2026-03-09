const sizes = {
  sm: 'w-3.5 h-3.5 border-2',
  md: 'w-5 h-5 border-2',
  lg: 'w-8 h-8 border-3',
};

interface LoadingSpinnerProps {
  size?: keyof typeof sizes;
  className?: string;
}

export default function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  return (
    <div className={`${sizes[size]} border-gray-600 border-t-blue-400 rounded-full animate-spin ${className}`} />
  );
}

export function LoadingText({ text = 'Laden...' }: { text?: string }) {
  return <p className="text-gray-500 text-sm">{text}</p>;
}
