import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkRateLimit, getClientIp, RateLimits } from '@/lib/rate-limit';

const profileSchema = z.object({
  name: z.string().min(2).max(40).optional(),
  displayName: z.string().min(1).max(60).optional(),
  bio: z.string().max(500).optional().nullable(),
  website: z.string().url().or(z.literal('')).optional().nullable(),
  location: z.string().max(80).optional().nullable(),
  image: z.string().url().or(z.literal('')).optional().nullable(),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(100).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  ),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      displayName: true,
      email: true,
      bio: true,
      website: true,
      location: true,
      image: true,
      role: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ user });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = profileSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = Object.fromEntries(
    Object.entries(parsed.data).map(([k, v]) => [k, v === '' ? null : v])
  );

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data,
    select: { id: true, name: true, displayName: true, email: true, bio: true, website: true, location: true, image: true },
  });

  return NextResponse.json({ user });
}

export async function POST(req: Request) {
  // password change
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Rate limiting for password change
  const ip = getClientIp(req);
  const rate = checkRateLimit(ip, RateLimits.auth);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rate.resetInSeconds) } }
    );
  }

  let json2: unknown;
  try {
    json2 = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = passwordSchema.safeParse(json2);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user || !user.password) {
    return NextResponse.json({ error: 'no_password_set' }, { status: 400 });
  }

  const ok = await bcrypt.compare(parsed.data.currentPassword, user.password);
  if (!ok) return NextResponse.json({ error: 'wrong_password' }, { status: 400 });

  const hashed = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashed },
  });
  return NextResponse.json({ ok: true });
}
