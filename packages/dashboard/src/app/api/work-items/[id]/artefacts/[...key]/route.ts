import { getArtefact } from '../../../../../../server/handlers.ts';
import { services } from '../../../../../../server/services.ts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; key: string[] }> }): Promise<Response> {
  const { id, key } = await params;
  return getArtefact(services(), id, key);
}
