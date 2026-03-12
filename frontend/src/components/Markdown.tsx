import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  children: string;
  className?: string;
}

export default function Markdown({ children, className = '' }: Props) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none
      prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0
      prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded
      prose-code:text-cyan-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
      prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
      prose-strong:text-gray-200 prose-em:text-gray-300
      prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-th:px-3 prose-th:py-1.5 prose-th:bg-gray-800 prose-th:text-gray-300
      prose-td:border prose-td:border-gray-700 prose-td:px-3 prose-td:py-1.5
      ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
