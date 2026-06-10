import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkRateLimit, getClientIp, RateLimits } from '@/lib/rate-limit';

const commentSchema = z.object({
  postId: z.string(),
  content: z.string().min(1).max(4000),
  guestName: z.string().min(1).max(40).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const postId = url.searchParams.get('postId');
  if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 });

  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawPageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 && rawPageSize <= 100
    ? Math.floor(rawPageSize)
    : 20;

  const [items, total] = await Promise.all([
    prisma.comment.findMany({
      where: { postId, approved: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { author: { select: { name: true, image: true } } },
    }),
    prisma.comment.count({ where: { postId, approved: true } }),
  ]);
  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  });
}

export async function POST(req: Request) {
  // Rate limiting
  const ip = getClientIp(req);
  const rate = checkRateLimit(ip, RateLimits.comment);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many comments. Please wait before posting again.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rate.resetInSeconds),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }
  const session = await auth();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = commentSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  // Verify post exists
  const post = await prisma.post.findUnique({ where: { id: parsed.data.postId } });
  if (!post) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  }

  // Verify parentId belongs to the same post if provided
  if (parsed.data.parentId) {
    const parent = await prisma.comment.findUnique({ where: { id: parsed.data.parentId } });
    if (!parent || parent.postId !== parsed.data.postId) {
      return NextResponse.json({ error: 'Invalid parent comment' }, { status: 400 });
    }
  }

  const data = {
    postId: parsed.data.postId,
    content: parsed.data.content,
    parentId: parsed.data.parentId ?? null,
    authorId: session?.user?.id ?? null,
    guestName: session ? null : parsed.data.guestName ?? 'Anonymous',
  };

  try {
    const comment = await prisma.comment.create({ data });
    return NextResponse.json({ comment }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}

// ─── PATCH: approve / unapprove a comment (admin only) ────────────────

const patchSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  // Only admin or comment author can moderate
  const comment = await prisma.comment.findUnique({
    where: { id: parsed.data.id },
    include: { post: { select: { authorId: true } } },
  });
  if (!comment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isAdmin = session.user.role === 'admin';
  const isPostOwner = session.user.id === comment.post.authorId;
  const isCommentAuthor = session.user.id === comment.authorId;

  if (!isAdmin && !isPostOwner && !isCommentAuthor) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const updated = await prisma.comment.update({
    where: { id: parsed.data.id },
    data: { approved: parsed.data.approved },
  });
  return NextResponse.json({ comment: updated });
}

// ─── DELETE: remove a comment ─────────────────────────────────────────

const deleteSchema = z.object({
  id: z.string(),
});

export async function DELETE(req: Request) {
  const session = await auth();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = deleteSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'comment id required' }, { status: 400 });
  }

  // Verify the comment exists and check permissions
  const comment = await prisma.comment.findUnique({
    where: { id: parsed.data.id },
    include: { post: { select: { authorId: true } } },
  });
  if (!comment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isAdmin = session?.user?.role === 'admin';
  const isPostOwner = session?.user?.id === comment.post.authorId;
  const isCommentAuthor = session?.user?.id === comment.authorId;

  if (!isAdmin && !isPostOwner && !isCommentAuthor) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.comment.delete({ where: { id: parsed.data.id } });
  return NextResponse.json({ ok: true });
}
