import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { RoomState } from '../types';

interface JoinParams {
  roomId: string;
  displayName: string;
  clientId: string;
  password?: string;
}

export function useSocket({ roomId, displayName, clientId, password }: JoinParams) {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!roomId || !displayName || !clientId) {
      return;
    }

    const socket = io({
      auth: { roomId, displayName, clientId, password },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
    });
    socket.on('connect_error', (err) => {
      setError(err.message);
      setConnected(false);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('room:state', (payload: RoomState) => setState(payload));

    return () => {
      socket.disconnect();
    };
  }, [roomId, displayName, clientId, password]);

  const castVote = (value: string | null) => socketRef.current?.emit('vote:cast', value);
  const reveal = () => socketRef.current?.emit('votes:reveal');
  const reset = () => socketRef.current?.emit('round:reset');

  return { state, error, connected, castVote, reveal, reset };
}
