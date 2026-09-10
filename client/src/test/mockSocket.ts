import { vi } from 'vitest';

export function createMockSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    __emitServerEvent(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
  };
}

export type MockSocket = ReturnType<typeof createMockSocket>;
