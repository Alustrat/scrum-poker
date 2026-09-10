import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoom, getRoomInfo } from './api';

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createRoom', () => {
    it('POSTs to /api/rooms with the room name and password', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'room-1' }));

      await createRoom('Sprint 42', 'secret');

      expect(fetch).toHaveBeenCalledWith('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sprint 42', password: 'secret' }),
      });
    });

    it('sends password as undefined when blank', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'room-1' }));

      await createRoom('Sprint 42', '');

      expect(fetch).toHaveBeenCalledWith(
        '/api/rooms',
        expect.objectContaining({
          body: JSON.stringify({ name: 'Sprint 42', password: undefined }),
        })
      );
    });

    it('resolves with the parsed body on success', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'room-1' }));

      await expect(createRoom('Sprint 42', '')).resolves.toEqual({ id: 'room-1' });
    });

    it('rejects with the server error message on failure', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Name taken' }, false));

      await expect(createRoom('Sprint 42', '')).rejects.toThrow('Name taken');
    });

    it('rejects with a fallback message when the error body cannot be parsed', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.reject(new Error('bad json')),
      } as unknown as Response);

      await expect(createRoom('Sprint 42', '')).rejects.toThrow('Failed to create room');
    });
  });

  describe('getRoomInfo', () => {
    it('fetches /api/rooms/:id and resolves the parsed body on success', async () => {
      const info = { id: 'room-1', name: 'Sprint 42', hasPassword: false };
      vi.mocked(fetch).mockResolvedValue(jsonResponse(info));

      await expect(getRoomInfo('room-1')).resolves.toEqual(info);
      expect(fetch).toHaveBeenCalledWith('/api/rooms/room-1');
    });

    it('rejects with the server error message on failure', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'No such room' }, false));

      await expect(getRoomInfo('room-1')).rejects.toThrow('No such room');
    });

    it('rejects with a fallback message when the error body cannot be parsed', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.reject(new Error('bad json')),
      } as unknown as Response);

      await expect(getRoomInfo('room-1')).rejects.toThrow('Room not found');
    });
  });
});
