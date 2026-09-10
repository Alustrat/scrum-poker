import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { getRoomInfo } from '../api';
import { useSocket } from '../hooks/useSocket';
import { DECK } from '../types';

const displayNameKey = (roomId: string) => `scrum-poker:displayName:${roomId}`;
const clientIdKey = (roomId: string) => `scrum-poker:clientId:${roomId}`;

function getOrCreateClientId(roomId: string): string {
  const key = clientIdKey(roomId);
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export default function Room() {
  const { id: roomId } = useParams<{ id: string }>();
  const [roomInfo, setRoomInfo] = useState<{ name: string; hasPassword: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nameInput, setNameInput] = useState(
    () => localStorage.getItem(displayNameKey(roomId ?? '')) ?? ''
  );
  const [passwordInput, setPasswordInput] = useState('');
  const [joinParams, setJoinParams] = useState<{ displayName: string; password: string } | null>(
    null
  );

  useEffect(() => {
    if (!roomId) return;
    getRoomInfo(roomId)
      .then((info) => setRoomInfo(info))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Room not found'));
  }, [roomId]);

  // Re-sync the name field (and require rejoining) whenever the room changes,
  // since the saved name is scoped per room.
  useEffect(() => {
    setNameInput(localStorage.getItem(displayNameKey(roomId ?? '')) ?? '');
    setJoinParams(null);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    const key = displayNameKey(roomId);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        setNameInput(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [roomId]);

  // Auto-join password-less rooms when a name was already saved for this room.
  useEffect(() => {
    if (!roomId || !roomInfo || roomInfo.hasPassword || joinParams) return;
    const savedName = localStorage.getItem(displayNameKey(roomId))?.trim();
    if (savedName) {
      setJoinParams({ displayName: savedName, password: '' });
    }
  }, [roomId, roomInfo, joinParams]);

  const clientId = useMemo(() => (roomId ? getOrCreateClientId(roomId) : ''), [roomId]);

  const { state, error, connected, castVote, reveal, reset } = useSocket({
    roomId: roomId ?? '',
    displayName: joinParams?.displayName ?? '',
    clientId,
    password: joinParams?.password,
  });

  if (loadError) {
    return (
      <div className="page">
        <h1>Room not found</h1>
        <p>{loadError}</p>
      </div>
    );
  }

  if (!roomInfo) {
    return (
      <div className="page">
        <p>Loading room…</p>
      </div>
    );
  }

  if (!joinParams || (error && !connected)) {
    return (
      <div className="page">
        <h1>{roomInfo.name}</h1>
        <form
          className="panel"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const name = nameInput.trim();
            /* v8 ignore next -- roomId is always set here: this form only renders once roomInfo has loaded, which requires roomId */
            if (!name || !roomId) return;
            localStorage.setItem(displayNameKey(roomId), name);
            setJoinParams({ displayName: name, password: passwordInput });
          }}
        >
          <label>
            Your name
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="e.g. Alex"
              autoFocus
            />
          </label>
          {roomInfo.hasPassword && (
            <label>
              Room password
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
              />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit">Join</button>
        </form>
      </div>
    );
  }

  const you = state?.participants.find((p) => p.id === clientId);
  const shareUrl = window.location.href;

  return (
    <div className="page">
      <h1>{roomInfo.name}</h1>
      <p className="room-link">
        Share this link to invite others: <code>{shareUrl}</code>
      </p>

      {!connected && <p>Connecting…</p>}

      <section className="participants">
        <h2>Participants</h2>
        <ul>
          {state?.participants.map((p) => (
            <li key={p.id} className={p.voted ? 'voted' : ''}>
              <span>{p.name}</span>
              <span className="vote-badge">
                {state.revealed ? p.vote ?? '—' : p.voted ? '✓' : '…'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="deck">
        <h2>Your estimate</h2>
        <div className="cards">
          {DECK.map((card) => (
            <button
              key={card}
              className={you?.vote === card ? 'card selected' : 'card'}
              onClick={() => castVote(card)}
            >
              {card}
            </button>
          ))}
        </div>
      </section>

      <section className="controls">
        <button onClick={reveal}>Reveal votes</button>
        <button onClick={reset}>New round</button>
      </section>
    </div>
  );
}
