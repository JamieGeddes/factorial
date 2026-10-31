import { getRun } from '../../../../../../server/handlers.ts';
import { services } from '../../../../../../server/services.ts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; stage: string; round: string }> }): Promise<Response> {
  const { id, stage, round } = await params;
  return getRun(services(), id, stage, round);
}
