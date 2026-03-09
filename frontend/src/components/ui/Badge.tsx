interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  rounded?: 'full' | 'default';
  className?: string;
}

export default function Badge({ children, color = 'bg-gray-800 text-gray-300', rounded = 'default', className = '' }: BadgeProps) {
  return (
    <span className={`text-xs px-2 py-0.5 ${rounded === 'full' ? 'rounded-full' : 'rounded'} ${color} ${className}`}>
      {children}
    </span>
  );
}
