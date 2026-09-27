import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const prismaMock = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn()
  });
  return {
    user: model(),
    session: model(),
    book: model(),
    dogEar: model(),
    annotation: model(),
    rereadMark: model(),
    completionReflection: model(),
    activityEvent: model(),
    $transaction: vi.fn(),
    $queryRaw: vi.fn()
  };
});

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));

const { buildApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/auth.js');

const USER_ID = '11111111-2222-4333-8444-555555555555';
const PASSWORD = 'correct-password';

function activeSession() {
  return {
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    user: {
      id: USER_ID,
      email: 'reader@example.com',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'ACTIVE',
      deletedAt: null
    }
  };
}

describe('DELETE /api/v1/auth/account', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
    prismaMock.session.findUnique.mockResolvedValue(activeSession());
  });

  function deleteAccount(password: string) {
    return app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: { cookie: 'pbt_session=test-token' },
      payload: { password }
    });
  }

  it('soft-deletes books, traces and reflections on one timeline and writes audit events', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: USER_ID,
      email: 'reader@example.com',
      passwordHash: await hashPassword(PASSWORD)
    });
    prismaMock.book.findMany.mockResolvedValue([
      { id: 'book-1', title: '书一' },
      { id: 'book-2', title: '书二' }
    ]);
    prismaMock.dogEar.findMany.mockResolvedValue([{ id: 'dog-ear-1', bookId: 'book-1' }]);
    prismaMock.annotation.findMany.mockResolvedValue([{ id: 'annotation-1', bookId: 'book-1' }]);
    prismaMock.rereadMark.findMany.mockResolvedValue([{ id: 'reread-1', bookId: 'book-2' }]);
    prismaMock.completionReflection.findMany.mockResolvedValue([{ id: 'reflection-1', bookId: 'book-2' }]);
    prismaMock.user.update.mockResolvedValue({ id: USER_ID });

    const response = await deleteAccount(PASSWORD);

    expect(response.statusCode).toBe(204);

    // 书目、折角、批注、重读、完成感受都被软删除，且只能软删除未删除的数据
    for (const model of ['book', 'dogEar', 'annotation', 'rereadMark', 'completionReflection'] as const) {
      const calls = prismaMock[model].updateMany.mock.calls;
      expect(calls, model).toHaveLength(1);
      expect(calls[0][0].where).toEqual({ userId: USER_ID, deletedAt: null });
      expect(calls[0][0].data.version).toEqual({ increment: 1 });
    }

    // 账号、会话与全部业务对象共用同一时间戳，保留与彻底清理按同一时间线处理
    const timeline = [
      prismaMock.book.updateMany.mock.calls[0][0].data.deletedAt,
      prismaMock.dogEar.updateMany.mock.calls[0][0].data.deletedAt,
      prismaMock.annotation.updateMany.mock.calls[0][0].data.deletedAt,
      prismaMock.rereadMark.updateMany.mock.calls[0][0].data.deletedAt,
      prismaMock.completionReflection.updateMany.mock.calls[0][0].data.deletedAt,
      prismaMock.session.updateMany.mock.calls[0][0].data.revokedAt,
      prismaMock.user.update.mock.calls[0][0].data.deletedAt
    ];
    for (const value of timeline) {
      expect(value).toBeInstanceOf(Date);
      expect(value.getTime()).toBe(timeline[0].getTime());
    }
    expect(prismaMock.user.update.mock.calls[0][0].data.status).toBe('DELETED');

    // 每个被清理的对象都有删除事件，恢复审计完整
    const events = prismaMock.activityEvent.create.mock.calls.map((call) => call[0].data);
    expect(events).toHaveLength(6);
    expect(events).toContainEqual({
      userId: USER_ID,
      bookId: 'book-1',
      entityType: 'BOOK',
      entityId: 'book-1',
      action: 'DELETED',
      payloadJson: { bookTitle: '书一', reason: 'account_deleted' }
    });
    expect(events).toContainEqual({
      userId: USER_ID,
      bookId: 'book-2',
      entityType: 'BOOK',
      entityId: 'book-2',
      action: 'DELETED',
      payloadJson: { bookTitle: '书二', reason: 'account_deleted' }
    });
    for (const [entityType, entityId, bookId] of [
      ['DOG_EAR', 'dog-ear-1', 'book-1'],
      ['ANNOTATION', 'annotation-1', 'book-1'],
      ['REREAD_MARK', 'reread-1', 'book-2'],
      ['COMPLETION_REFLECTION', 'reflection-1', 'book-2']
    ] as const) {
      expect(events).toContainEqual({
        userId: USER_ID,
        bookId,
        entityType,
        entityId,
        action: 'DELETED',
        payloadJson: { cascade: true, reason: 'account_deleted' }
      });
    }

    const setCookie = response.headers['set-cookie'];
    expect(String(setCookie)).toContain('pbt_session=');
  });

  it('rejects a wrong password without touching any data', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: USER_ID,
      email: 'reader@example.com',
      passwordHash: await hashPassword(PASSWORD)
    });

    const response = await deleteAccount('wrong-password');

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('INVALID_PASSWORD');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.book.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('requires an authenticated session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      payload: { password: PASSWORD }
    });

    expect(response.statusCode).toBe(401);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
