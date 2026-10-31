import { getStatus } from '../../../server/handlers.ts';
import { services } from '../../../server/services.ts';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return getStatus(services());
}
