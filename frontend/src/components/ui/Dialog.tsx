import React from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ title, onClose, children }) => {
  return (
    <div className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 max-w-lg w-full mx-4 overflow-hidden">
      <div className="bg-violet-500/10 border-b border-violet-500/30 px-5 py-3 flex items-center justify-between">
        <span className="text-sm font-medium text-violet-300">{title}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
          &times;
        </button>
      </div>
      {children}
    </div>
  );
};

export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      {children}
    </div>
  );
};
