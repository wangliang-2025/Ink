import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { listPosts, createPost } from '@/lib/posts';

// Cover image can be either a remote URL, a data: URL (for locally-picked
// and client-compressed images), or empty. We validate loosely to avoid
// rejecting the long data URLs produced by the editor.
const coverImageSchema = z
  .string()
  .max(5_000_000)
  .refine(
    (s) => s.length === 0 || /^(https?:|data:image\/)/i.test(s),
    'Invalid cover image URL'
  )
  .nullable()
  .optional();

const postSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().optional(),
  content: z.string().min(1),
  excerpt: z.string().optional(),
  coverImage: coverImageSchema,
  locale: z.enum(['zh', 'en']).optional(),
  visibility: z.enum(['public', 'private', 'unlisted']).optional(),
  allowEmbed: z.boolean().optional(),
  categoryId: z.string().nullable().optional(),
  published: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawPageSize = Number(url.searchParams.get('pageSize') ?? '10');

  // Validate pagination parameters
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 && rawPageSize <= 100
    ? Math.floor(rawPageSize)
    : 10;

  const locale = url.searchParams.get('locale') ?? undefined;
  const tag = url.searchParams.get('tag') ?? undefined;
  const category = url.searchParams.get('category') ?? undefined;
  const query = url.searchParams.get('q') ?? undefined;

  const data = await listPosts({ page, pageSize, locale, tag, category, query });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const json = await req.json();
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const post = await createPost({
    ...parsed.data,
    authorId: session.user.id,
  });
  return NextResponse.json({ post }, { status: 201 });
}
