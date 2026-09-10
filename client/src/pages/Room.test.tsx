import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRoomInfo } from '../api';
import { useSocket } from '../hooks/useSocket';
import { DECK } from '../types';
import Room from './Room';

vi.mock('../api');
vi.mock('../hooks/useSocket');

const defaultSocketReturn = {
  state: null,
  error: null,
  connected: false,
  castVote: vi.fn(),
  reveal: vi.fn(),
  reset: vi.fn(),
};

function renderRoom(roomId = 'room-1') {
  return render(
    <MemoryRouter initialEntries={[`/room/${roomId}`]}>
      <Routes>
        <Route path="/room/:id" element={<Room />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Room', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getRoomInfo).mockReset();
    vi.mocked(useSocket).mockReset();
    vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn });
    let uuidCount = 0;
    vi.stubGlobal('crypto', {
      ...crypto,
      randomUUID: vi.fn(() => `generated-uuid-${++uuidCount}`) as unknown as typeof crypto.randomUUID,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generates and persists a clientId when none is stored', () => {
    vi.mocked(getRoomInfo).mockReturnValue(new Promise(() => {}));
    renderRoom('room-1');

    expect(localStorage.getItem('scrum-poker:clientId:room-1')).toBe('generated-uuid-1');
  });

  it('reuses the stored clientId instead of generating a new one', () => {
    localStorage.setItem('scrum-poker:clientId:room-1', 'existing-id');
    vi.mocked(getRoomInfo).mockReturnValue(new Promise(() => {}));
    renderRoom('room-1');

    expect(localStorage.getItem('scrum-poker:clientId:room-1')).toBe('existing-id');
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('shows a loading state before room info resolves', () => {
    vi.mocked(getRoomInfo).mockReturnValue(new Promise(() => {}));
    renderRoom();

    expect(screen.getByText('Loading room…')).toBeInTheDocument();
  });

  it('shows the error message when room info fails to load', async () => {
    vi.mocked(getRoomInfo).mockRejectedValue(new Error('No such room'));
    renderRoom();

    await waitFor(() => expect(screen.getByText('Room not found')).toBeInTheDocument());
    expect(screen.getByText('No such room')).toBeInTheDocument();
  });

  it('shows a fallback message when room info fails with a non-Error', async () => {
    vi.mocked(getRoomInfo).mockRejectedValue('nope');
    renderRoom();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Room not found' })).toBeInTheDocument()
    );
    expect(screen.getByText('Room not found', { selector: 'p' })).toBeInTheDocument();
  });

  it('shows only a name field when the room has no password', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: false,
    });
    renderRoom();

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());
    expect(screen.queryByLabelText('Room password')).not.toBeInTheDocument();
  });

  it('shows a password field when the room has a password', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: true,
    });
    renderRoom();

    await waitFor(() => expect(screen.getByLabelText('Room password')).toBeInTheDocument());
  });

  it('persists the display name and joins with the socket hook on submit', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: true,
    });
    const user = userEvent.setup();
    renderRoom('room-1');

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Your name'), 'Alex');
    await user.type(screen.getByLabelText('Room password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect(localStorage.getItem('scrum-poker:displayName:room-1')).toBe('Alex');
    expect(useSocket).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayName: 'Alex', password: 'secret' })
    );
  });

  it('auto-joins when a display name is already saved and the room has no password', async () => {
    localStorage.setItem('scrum-poker:displayName:room-1', 'Alex');
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: false,
    });
    vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn, connected: true });
    renderRoom('room-1');

    await waitFor(() =>
      expect(useSocket).toHaveBeenLastCalledWith(
        expect.objectContaining({ displayName: 'Alex' })
      )
    );
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
  });

  it('keeps showing the voting UI once connected even if a stale error remains', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: false,
    });
    vi.mocked(useSocket).mockReturnValue({
      ...defaultSocketReturn,
      connected: true,
      error: 'stale error',
      state: { revealed: false, participants: [] },
    });
    const user = userEvent.setup();
    renderRoom('room-1');

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Your name'), 'Alex');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
    expect(screen.getByText('Your estimate')).toBeInTheDocument();
  });

  it('shows the join form again with the error when the hook reports an error while disconnected', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: false,
    });
    vi.mocked(useSocket).mockReturnValue({
      ...defaultSocketReturn,
      connected: false,
      error: 'Invalid password',
    });
    const user = userEvent.setup();
    renderRoom('room-1');

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Your name'), 'Alex');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect(screen.getByText('Invalid password')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
  });

  describe('voting UI', () => {
    async function joinRoom(user: ReturnType<typeof userEvent.setup>) {
      vi.mocked(getRoomInfo).mockResolvedValue({
        id: 'room-1',
        name: 'Sprint 42',
        hasPassword: false,
      });
      renderRoom('room-1');
      await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Your name'), 'Alex');
      await user.click(screen.getByRole('button', { name: 'Join' }));
    }

    it('shows the correct badge per participant based on vote/reveal state', async () => {
      localStorage.setItem('scrum-poker:clientId:room-1', 'me');
      vi.mocked(useSocket).mockReturnValue({
        ...defaultSocketReturn,
        connected: true,
        state: {
          revealed: false,
          participants: [
            { id: 'me', name: 'Alex', voted: false, vote: null },
            { id: 'other', name: 'Sam', voted: true, vote: '5' },
          ],
        },
      });
      const user = userEvent.setup();
      await joinRoom(user);

      const alexRow = screen.getByText('Alex').closest('li')!;
      const samRow = screen.getByText('Sam').closest('li')!;
      expect(alexRow).toHaveTextContent('…');
      expect(samRow).toHaveTextContent('✓');
    });

    it('shows the actual vote once revealed, or a dash if none was cast', async () => {
      vi.mocked(useSocket).mockReturnValue({
        ...defaultSocketReturn,
        connected: true,
        state: {
          revealed: true,
          participants: [
            { id: 'me', name: 'Alex', voted: true, vote: '8' },
            { id: 'other', name: 'Sam', voted: false, vote: null },
          ],
        },
      });
      const user = userEvent.setup();
      await joinRoom(user);

      expect(screen.getByText('Alex').closest('li')).toHaveTextContent('8');
      expect(screen.getByText('Sam').closest('li')).toHaveTextContent('—');
    });

    it('renders all deck cards and casts a vote on click', async () => {
      const castVote = vi.fn();
      vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn, connected: true, castVote });
      const user = userEvent.setup();
      await joinRoom(user);

      for (const card of DECK) {
        expect(screen.getByRole('button', { name: card })).toBeInTheDocument();
      }

      await user.click(screen.getByRole('button', { name: '5' }));
      expect(castVote).toHaveBeenCalledWith('5');
    });

    it('marks the current participant\'s card as selected', async () => {
      localStorage.setItem('scrum-poker:clientId:room-1', 'me');
      vi.mocked(useSocket).mockReturnValue({
        ...defaultSocketReturn,
        connected: true,
        state: {
          revealed: false,
          participants: [{ id: 'me', name: 'Alex', voted: true, vote: '13' }],
        },
      });
      const user = userEvent.setup();
      await joinRoom(user);

      expect(screen.getByRole('button', { name: '13' })).toHaveClass('selected');
      expect(screen.getByRole('button', { name: '5' })).not.toHaveClass('selected');
    });

    it('shows "Connecting…" only while not connected', async () => {
      vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn, connected: false });
      const user = userEvent.setup();
      await joinRoom(user);

      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    it('does not show "Connecting…" once connected', async () => {
      vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn, connected: true });
      const user = userEvent.setup();
      await joinRoom(user);

      expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    });

    it('calls reveal and reset from the control buttons', async () => {
      const reveal = vi.fn();
      const reset = vi.fn();
      vi.mocked(useSocket).mockReturnValue({ ...defaultSocketReturn, connected: true, reveal, reset });
      const user = userEvent.setup();
      await joinRoom(user);

      await user.click(screen.getByRole('button', { name: 'Reveal votes' }));
      await user.click(screen.getByRole('button', { name: 'New round' }));

      expect(reveal).toHaveBeenCalled();
      expect(reset).toHaveBeenCalled();
    });
  });

  it('syncs the name input from a storage event while the join form is visible', async () => {
    vi.mocked(getRoomInfo).mockResolvedValue({
      id: 'room-1',
      name: 'Sprint 42',
      hasPassword: false,
    });
    renderRoom('room-1');

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'scrum-poker:displayName:room-1',
          newValue: 'Jordan',
        })
      );
    });

    expect(screen.getByLabelText('Your name')).toHaveValue('Jordan');
  });
});
