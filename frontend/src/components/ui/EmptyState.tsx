interface EmptyStateProps {
  message: string;
  children?: React.ReactNode;
}

export default function EmptyState({ message, children }: EmptyStateProps) {
  return (
    <p className="text-gray-500 text-sm">
      {message}
      {children}
    </p>
  );
}
