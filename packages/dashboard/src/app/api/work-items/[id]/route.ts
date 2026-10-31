import { getWorkItem } from '../../../../server/handlers.ts';
import { services } from '../../../../server/services.ts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return getWorkItem(services(), (await params).id);
}
