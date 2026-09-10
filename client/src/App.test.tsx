import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { getRoomInfo } from './api';
import { useSocket } from './hooks/useSocket';

vi.mock('./api');
vi.mock('./hooks/useSocket');

describe('App', () => {
  beforeEach(() => {
    vi.mocked(getRoomInfo).mockReset();
    vi.mocked(useSocket).mockReset();
    vi.mocked(useSocket).mockReturnValue({
      state: null,
      error: null,
      connected: false,
      castVote: vi.fn(),
      reveal: vi.fn(),
      reset: vi.fn(),
    });
  });

  it('renders Home at "/"', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText('Scrum Poker')).toBeInTheDocument();
  });

  it('renders Room at "/room/:id" without crashing', async () => {
    vi.mocked(getRoomInfo).mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={['/room/abc123']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Loading room…')).toBeInTheDocument());
  });
});
