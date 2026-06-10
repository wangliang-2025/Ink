import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { renderMarkdown } from '@/lib/markdown';

export async function POST(req: Request) {
  // Authenticated users can use the preview endpoint.
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { content, allowEmbed = true } = body as { content?: unknown; allowEmbed?: unknown };
  if (typeof content !== 'string') {
    return NextResponse.json({ error: 'content required' }, { status: 400 });
  }
  const html = await renderMarkdown(content, { allowEmbed: !!allowEmbed });
  return NextResponse.json({ html });
}
