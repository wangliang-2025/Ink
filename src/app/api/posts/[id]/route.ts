import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { updatePost } from '@/lib/posts';

const coverImageSchema = z
  .string()
  .max(5_000_000)
  .refine(
    (s) => s.length === 0 || /^(https?:|data:image\/)/i.test(s),
    'Invalid cover image URL'
  )
  .nullable()
  .optional();

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  coverImage: coverImageSchema,
  locale: z.enum(['zh', 'en']).optional(),
  visibility: z.enum(['public', 'private', 'unlisted']).optional(),
  allowEmbed: z.boolean().optional(),
  categoryId: z.string().nullable().optional(),
  published: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

async function ensureOwner(id: string) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return null;
  if (post.authorId !== session.user.id && session.user.role !== 'admin') return null;
  return { session, post };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      tags: { include: { tag: true } },
      category: true,
      author: { select: { id: true, name: true, displayName: true } },
    },
  });
  if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Visibility check: private/unlisted/draft posts require ownership or admin
  const isPublic = post.published && (post.visibility === 'public' || post.visibility === 'unlisted');
  if (!isPublic) {
    const session = await auth();
    const isOwner = session?.user?.id === post.authorId;
    const isAdmin = session?.user?.role === 'admin';
    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  return NextResponse.json({ post });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await ensureOwner(id);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const post = await updatePost(id, parsed.data);
    return NextResponse.json({ post });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 400 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await ensureOwner(id);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    await prisma.post.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
