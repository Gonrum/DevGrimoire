import ReactMarkdown from 'react-markdown';

interface Props {
  children: string;
  className?: string;
}

export default function Markdown({ children, className = '' }: Props) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none
      prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0
      prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded
      prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
      prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
      prose-strong:text-gray-200 prose-em:text-gray-300
      ${className}`}>
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
