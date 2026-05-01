import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface WorkflowPageShellProps {
  backTo: string;
  backLabel: ReactNode;
  title?: ReactNode;
  children: ReactNode;
  maxWidth?: string;
}

export function WorkflowPageShell({ backTo, backLabel, title, children, maxWidth = 'max-w-3xl' }: WorkflowPageShellProps) {
  return (
    <div>
      <Link to={backTo} className="mb-6 inline-block text-sm text-gray-500 hover:text-gray-300">&larr; {backLabel}</Link>
      <div className={`${maxWidth} mx-auto`}>
        {title && <h1 className="mb-6 text-xl font-bold">{title}</h1>}
        {children}
      </div>
    </div>
  );
}

interface WorkflowModalShellProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: string;
}

export function WorkflowModalShell({ title, children, onClose, maxWidth = 'max-w-lg' }: WorkflowModalShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className={`mx-4 max-h-[90vh] w-full ${maxWidth} overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-200">{title}</h2>
          <button type="button" onClick={onClose} className="text-xl leading-none text-gray-500 hover:text-gray-300">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}
