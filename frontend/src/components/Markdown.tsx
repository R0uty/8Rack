import { useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(preRef.current?.textContent ?? "");
    } catch {
      return; // Clipboard permission denied - the text is still there to select by hand.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/code relative">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted opacity-0 transition-opacity hover:text-text group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={preRef} className="!rounded-lg !border !border-border" {...props}>
        {children}
      </pre>
    </div>
  );
}

/** Everything rendered here is agent output built from data the target controls. An image would load
 * as soon as it's viewed - a request to an attacker's server carrying whatever a prompt-injected agent
 * put in the URL - so it only becomes a request if a human chooses to follow it. */
function ImageAsLink({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const label = alt?.trim() || "image";
  if (!src) return <span>{label}</span>;
  return <ExternalLink href={src}>{`[image: ${label}]`}</ExternalLink>;
}

function ExternalLink({ children, href }: ComponentPropsWithoutRef<"a">) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="prose prose-8rack prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock, img: ImageAsLink, a: ExternalLink }}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
