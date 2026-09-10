import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom } from '../api';

export default function Home() {
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [joinId, setJoinId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!roomName.trim()) {
      setError('Please enter a room name');
      return;
    }
    setCreating(true);
    try {
      const room = await createRoom(roomName.trim(), password);
      navigate(`/room/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setCreating(false);
    }
  }

  function handleJoin(e: FormEvent) {
    e.preventDefault();
    const id = joinId.trim();
    if (!id) return;
    navigate(`/room/${id}`);
  }

  return (
    <div className="page">
      <h1>Scrum Poker</h1>
      <p className="subtitle">Estimate tasks together, in real time.</p>

      <div className="panels">
        <form className="panel" onSubmit={handleCreate}>
          <h2>Create a room</h2>
          <label>
            Room name
            <input
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Sprint 42 planning"
              maxLength={80}
            />
          </label>
          <label>
            Password (optional)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank for no password"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create room'}
          </button>
        </form>

        <form className="panel" onSubmit={handleJoin}>
          <h2>Join a room</h2>
          <label>
            Room ID
            <input
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              placeholder="Paste a room ID or link"
            />
          </label>
          <button type="submit">Join room</button>
        </form>
      </div>
    </div>
  );
}
