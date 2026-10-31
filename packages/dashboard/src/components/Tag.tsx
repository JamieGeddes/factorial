/** An id or a reference, in the monospace tag style. */
export function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <span className="tag" {...(title ? { title } : {})}>
      {children}
    </span>
  );
}
