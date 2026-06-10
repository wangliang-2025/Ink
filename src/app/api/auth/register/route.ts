import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { checkRateLimit, getClientIp, RateLimits } from '@/lib/rate-limit';

const schema = z.object({
  name: z.string().min(2).max(40).optional(),
  email: z.string().email(),
  password: z.string().min(8).max(100).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  ),
});

export async function POST(req: Request) {
  // Rate limiting
  const ip = getClientIp(req);
  const rate = checkRateLimit(ip, RateLimits.register);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many registration attempts. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rate.resetInSeconds),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { email, password, name } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'email_exists' }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      name: name || email.split('@')[0],
      displayName: name || email.split('@')[0],
      password: hashed,
      role: 'user',
    },
    select: { id: true, email: true, name: true, displayName: true },
  });

  return NextResponse.json({ user }, { status: 201 });
}
