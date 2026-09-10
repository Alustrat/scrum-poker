import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoom } from '../api';
import Home from './Home';

vi.mock('../api');

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:id" element={<div>Room page: room id is</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Home', () => {
  beforeEach(() => {
    vi.mocked(createRoom).mockReset();
  });

  it('shows an error and does not create a room when the name is blank', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Create room' }));

    expect(screen.getByText('Please enter a room name')).toBeInTheDocument();
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('shows an error and does not create a room when the name is only whitespace', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    expect(screen.getByText('Please enter a room name')).toBeInTheDocument();
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('creates a room with the trimmed name and untrimmed password', async () => {
    vi.mocked(createRoom).mockResolvedValue({ id: 'room-1' });
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), '  Sprint 42  ');
    await user.type(screen.getByLabelText('Password (optional)'), ' secret ');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    expect(createRoom).toHaveBeenCalledWith('Sprint 42', ' secret ');
  });

  it('disables the submit button and shows a pending label while creating', async () => {
    let resolveCreate: (value: { id: string }) => void = () => {};
    vi.mocked(createRoom).mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), 'Sprint 42');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    const pendingButton = screen.getByRole('button', { name: 'Creating…' });
    expect(pendingButton).toBeDisabled();

    resolveCreate({ id: 'room-1' });
    await waitFor(() => expect(screen.getByText(/Room page/)).toBeInTheDocument());
  });

  it('navigates to the new room on success', async () => {
    vi.mocked(createRoom).mockResolvedValue({ id: 'room-1' });
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), 'Sprint 42');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    await waitFor(() => expect(screen.getByText(/Room page/)).toBeInTheDocument());
  });

  it('shows the error message and re-enables the button on rejection', async () => {
    vi.mocked(createRoom).mockRejectedValue(new Error('Name taken'));
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), 'Sprint 42');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    await waitFor(() => expect(screen.getByText('Name taken')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
  });

  it('shows a fallback error message for a non-Error rejection', async () => {
    vi.mocked(createRoom).mockRejectedValue('nope');
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room name'), 'Sprint 42');
    await user.click(screen.getByRole('button', { name: 'Create room' }));

    await waitFor(() =>
      expect(screen.getByText('Failed to create room')).toBeInTheDocument()
    );
  });

  it('does not navigate when the join id is blank or whitespace', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room ID'), '   ');
    await user.click(screen.getByRole('button', { name: 'Join room' }));

    expect(screen.queryByText(/Room page/)).not.toBeInTheDocument();
  });

  it('navigates to the trimmed room id on join', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText('Room ID'), '  abc123  ');
    await user.click(screen.getByRole('button', { name: 'Join room' }));

    await waitFor(() => expect(screen.getByText(/Room page/)).toBeInTheDocument());
  });
});
