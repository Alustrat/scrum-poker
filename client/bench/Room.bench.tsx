import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { bench, describe, vi } from 'vitest';
import { getRoomInfo } from '../src/api';
import { useSocket } from '../src/hooks/useSocket';
import Room from '../src/pages/Room';
import { DECK, type Participant, type RoomState } from '../src/types';

vi.mock('../src/api');
vi.mock('../src/hooks/useSocket');

const ROOM_ID = 'bench-room';
const CLIENT_ID = 'client-0';

function makeState(participants: number, revealed: boolean, round = 0): RoomState {
  const list: Participant[] = [];
  for (let i = 0; i < participants; i++) {
    const voted = (i + round) % 4 !== 0;
    list.push({
      id: `client-${i}`,
      name: `Participant ${i}`,
      voted,
      vote: voted && (revealed || i === 0) ? DECK[(i + round) % DECK.length] : null,
    });
  }
  return { revealed, participants: list };
}

function mockRoom(state: RoomState | null, hasPassword = false) {
  vi.mocked(getRoomInfo).mockResolvedValue({ id: ROOM_ID, name: 'Sprint planning', hasPassword });
  vi.mocked(useSocket).mockReturnValue({
    state,
    error: null,
    connected: state !== null,
    castVote: () => undefined,
    reveal: () => undefined,
    reset: () => undefined,
  });
}

function roomPage() {
  return (
    <MemoryRouter initialEntries={[`/room/${ROOM_ID}`]}>
      <Routes>
        <Route path="/room/:id" element={<Room />} />
      </Routes>
    </MemoryRouter>
  );
}

// act() flushes the resolved getRoomInfo promise and the resulting state
// updates, so each iteration measures a full mount up to the settled page.
// Mocks and localStorage are (re)initialized inside each benchmark body since
// that per-iteration setup is negligible compared to the React render.
async function mountRoom() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(roomPage());
  });
  return result;
}

describe('Room page', () => {
  bench('mount - join form (password-protected room)', async () => {
    localStorage.clear();
    mockRoom(null, true);
    await mountRoom();
    cleanup();
  });

  bench('mount - 20 participants, votes hidden', async () => {
    localStorage.clear();
    localStorage.setItem(`scrum-poker:displayName:${ROOM_ID}`, 'Participant 0');
    localStorage.setItem(`scrum-poker:clientId:${ROOM_ID}`, CLIENT_ID);
    mockRoom(makeState(20, false));
    await mountRoom();
    cleanup();
  });

  bench('mount + 10 live state updates - 20 participants', async () => {
    localStorage.clear();
    localStorage.setItem(`scrum-poker:displayName:${ROOM_ID}`, 'Participant 0');
    localStorage.setItem(`scrum-poker:clientId:${ROOM_ID}`, CLIENT_ID);
    mockRoom(makeState(20, false));
    const { rerender } = await mountRoom();
    for (let round = 1; round <= 10; round++) {
      mockRoom(makeState(20, round % 2 === 0, round));
      await act(async () => {
        rerender(roomPage());
      });
    }
    cleanup();
  });
});
