import { getWorkItems } from '../../../server/handlers.ts';
import { services } from '../../../server/services.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return getWorkItems(request, services());
}
