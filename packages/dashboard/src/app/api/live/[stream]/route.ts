import { postLiveChannels } from '../../../../server/handlers.ts';
import { services } from '../../../../server/services.ts';

export const dynamic = 'force-dynamic';

/** Changes the channels one tab's stream carries. It writes nothing: the set lives in this process's memory. */
export async function POST(request: Request, { params }: { params: Promise<{ stream: string }> }): Promise<Response> {
  return postLiveChannels(request, services(), (await params).stream);
}
