import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react';

import { hashOf } from '../routes.ts';

/** `next/link` in the static page: a plain anchor to the view's hash name. */
export default function Link({ href, children, ref, ...rest }: { href: string; children?: ReactNode; ref?: Ref<HTMLAnchorElement> } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a href={`#${hashOf(href)}`} ref={ref} {...rest}>
      {children}
    </a>
  );
}
