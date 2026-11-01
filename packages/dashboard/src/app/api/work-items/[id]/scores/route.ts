import { postScores } from '../../../../../server/scores.ts';
import { services } from '../../../../../server/services.ts';

export const dynamic = 'force-dynamic';

/** A human score on the item's current attempt (#227): the app's only write. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return postScores(request, services(), (await params).id);
}
