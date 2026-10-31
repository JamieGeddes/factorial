import { useSyncExternalStore } from 'react';

import { hashOf, pathOf } from '../routes.ts';

/** `next/navigation` in the static page: the path is the hash, and moving is setting it. */
const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => pathOf(window.location.hash), () => '/');
}

export function useRouter() {
  return {
    push(href: string) {
      window.location.hash = hashOf(href);
    },
    replace(href: string) {
      window.location.hash = hashOf(href);
    },
    back() {
      window.history.back();
    },
    refresh() {},
    prefetch() {},
  };
}

export function notFound(): never {
  throw new Error('not found');
}
