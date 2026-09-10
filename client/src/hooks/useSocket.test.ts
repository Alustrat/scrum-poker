import { act, renderHook } from '@testing-library/react';
import { io } from 'socket.io-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSocket, type MockSocket } from '../test/mockSocket';
import { useSocket } from './useSocket';

vi.mock('socket.io-client', () => ({
  io: vi.fn(),
}));

describe('useSocket', () => {
  let socket: MockSocket;

  beforeEach(() => {
    socket = createMockSocket();
    vi.mocked(io).mockReturnValue(socket as never);
  });

  it.each([
    { roomId: '', displayName: 'Alex', clientId: 'c1' },
    { roomId: 'r1', displayName: '', clientId: 'c1' },
    { roomId: 'r1', displayName: 'Alex', clientId: '' },
  ])('does not connect when a required field is missing (%o)', (params) => {
    renderHook(() => useSocket(params));

    expect(io).not.toHaveBeenCalled();
  });

  it('connects with the join params once all required fields are present', () => {
    renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1', password: 'pw' })
    );

    expect(io).toHaveBeenCalledWith({
      auth: { roomId: 'r1', displayName: 'Alex', clientId: 'c1', password: 'pw' },
    });
  });

  it('registers listeners for connect, connect_error, disconnect, and room:state', () => {
    renderHook(() => useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' }));

    expect(socket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('connect_error', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('room:state', expect.any(Function));
  });

  it('sets connected and clears error on connect', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );

    act(() => socket.__emitServerEvent('connect_error', new Error('bad password')));
    act(() => socket.__emitServerEvent('connect'));

    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('sets error and clears connected on connect_error', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );

    act(() => socket.__emitServerEvent('connect'));
    act(() => socket.__emitServerEvent('connect_error', new Error('bad password')));

    expect(result.current.error).toBe('bad password');
    expect(result.current.connected).toBe(false);
  });

  it('sets connected to false on disconnect', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );

    act(() => socket.__emitServerEvent('connect'));
    act(() => socket.__emitServerEvent('disconnect'));

    expect(result.current.connected).toBe(false);
  });

  it('updates state on room:state', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );
    const payload = { revealed: false, participants: [] };

    act(() => socket.__emitServerEvent('room:state', payload));

    expect(result.current.state).toEqual(payload);
  });

  it('emits vote:cast, votes:reveal, and round:reset via the action functions', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );

    act(() => result.current.castVote('5'));
    act(() => result.current.reveal());
    act(() => result.current.reset());

    expect(socket.emit).toHaveBeenCalledWith('vote:cast', '5');
    expect(socket.emit).toHaveBeenCalledWith('votes:reveal');
    expect(socket.emit).toHaveBeenCalledWith('round:reset');
  });

  it('does not throw calling actions when never connected', () => {
    const { result } = renderHook(() =>
      useSocket({ roomId: '', displayName: '', clientId: '' })
    );

    expect(() => {
      result.current.castVote('5');
      result.current.reveal();
      result.current.reset();
    }).not.toThrow();
  });

  it('disconnects the socket on unmount', () => {
    const { unmount } = renderHook(() =>
      useSocket({ roomId: 'r1', displayName: 'Alex', clientId: 'c1' })
    );

    unmount();

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('disconnects the old socket and reconnects when a dependency changes', () => {
    const { rerender } = renderHook(
      ({ roomId }) => useSocket({ roomId, displayName: 'Alex', clientId: 'c1' }),
      { initialProps: { roomId: 'r1' } }
    );
    const firstSocket = socket;
    const secondSocket = createMockSocket();
    vi.mocked(io).mockReturnValue(secondSocket as never);

    rerender({ roomId: 'r2' });

    expect(firstSocket.disconnect).toHaveBeenCalled();
    expect(io).toHaveBeenLastCalledWith({
      auth: { roomId: 'r2', displayName: 'Alex', clientId: 'c1', password: undefined },
    });
  });
});
